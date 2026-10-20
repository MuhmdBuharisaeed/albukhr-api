"use strict";

const MAINNET = "mainnet";
const SCALE_DIGITS = 7;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const RESERVED_WITHDRAWAL_STATUSES = new Set(["pending", "approved", "paid"]);
const IN_PROGRESS_WITHDRAWAL_STATUSES = new Set(["pending", "approved"]);
const ALL_WITHDRAWAL_STATUSES = new Set(["pending", "approved", "paid", "rejected", "cancelled"]);
const ALL_STAKE_STATUSES = new Set(["active", "matured", "capital_withdrawn", "cancelled"]);

function contractError(message) {
  const error = new Error(message);
  error.code = "WALLET_DATA_INVALID";
  return error;
}

/* Parse decimal Pi values as fixed-point integers, avoiding binary-float math. */
function toUnits(value, fieldName) {
  if (value === null || value === undefined || value === "") return 0n;
  let text = String(value).trim();
  if (/e/i.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || numeric < 0) throw contractError(`${fieldName} is invalid.`);
    text = numeric.toFixed(SCALE_DIGITS);
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw contractError(`${fieldName} is invalid.`);
  const whole = BigInt(match[1]);
  const fractionRaw = match[2] || "";
  const fraction = fractionRaw.slice(0, SCALE_DIGITS).padEnd(SCALE_DIGITS, "0");
  let units = whole * SCALE + BigInt(fraction || "0");
  if (fractionRaw.length > SCALE_DIGITS && Number(fractionRaw[SCALE_DIGITS]) >= 5) units += 1n;
  return units;
}

function fromUnits(units) {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / SCALE;
  const fraction = String(absolute % SCALE).padStart(SCALE_DIGITS, "0").replace(/0+$/, "");
  const result = fraction ? `${whole}.${fraction}` : String(whole);
  return Number(negative ? `-${result}` : result);
}

function nonNegativeDifference(source, deductions) {
  return source > deductions ? source - deductions : 0n;
}

function requiredText(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw contractError(`${field} is missing.`);
  return text;
}

function normalizeStatus(value, allowed, field) {
  const status = String(value ?? "").trim().toLowerCase();
  if (!allowed.has(status)) throw contractError(`${field} has an unsupported status.`);
  return status;
}

function safeDate(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function keyFor(stakeId, type) {
  return `${stakeId}:${type}`;
}

/**
 * Build an allowlisted Wallet snapshot from server-side Mainnet RPC rows.
 * All amounts are fixed-point internally. Requestable amounts are zero when
 * the database-registered destination is missing; the client must still
 * compare this address to its current Pi SDK session before showing a CTA.
 */
function buildWalletSnapshot({ stakes, withdrawals, registeredWalletAddress, asOf = new Date().toISOString() }) {
  if (!Array.isArray(stakes) || !Array.isArray(withdrawals)) {
    throw contractError("Wallet source data is not in the expected format.");
  }

  const nowMs = Date.parse(asOf);
  if (!Number.isFinite(nowMs)) throw contractError("Wallet snapshot time is invalid.");

  for (const row of stakes) {
    if (String(row?.network ?? "").toLowerCase() !== MAINNET) {
      throw contractError("A non-Mainnet stake was returned to the Mainnet Wallet.");
    }
  }
  for (const row of withdrawals) {
    if (String(row?.network ?? "").toLowerCase() !== MAINNET) {
      throw contractError("A non-Mainnet withdrawal was returned to the Mainnet Wallet.");
    }
  }

  const positions = stakes.map((row) => {
    const stakeId = requiredText(row.id, "stake.id");
    const status = normalizeStatus(row.status, ALL_STAKE_STATUSES, "stake.status");
    if (row.amount === null || row.amount === undefined || row.amount === "") {
      throw contractError("stake.amount is missing.");
    }
    const principal = toUnits(row.amount, "stake.amount");
    const reward = toUnits(row.reward_amount, "stake.reward_amount");
    const unlockAt = safeDate(row.unlock_at);
    const unlockMs = unlockAt ? Date.parse(unlockAt) : NaN;
    const canUsePosition = ["active", "matured"].includes(status) && Number.isFinite(unlockMs) && unlockMs <= nowMs;
    return {
      source: row,
      stake_id: stakeId,
      project_code: row.project_code == null ? null : String(row.project_code),
      status,
      principal_units: principal,
      reward_units: reward,
      unlock_at: unlockAt,
      started_at: safeDate(row.start_at || row.created_at),
      can_use_position: canUsePosition
    };
  });

  const deductions = new Map();
  const openStatuses = new Map();
  const safeWithdrawals = [];
  let pendingToUser = 0n;
  let pendingFee = 0n;
  let pendingTotalDeduction = 0n;
  let paidToUser = 0n;
  let paidFee = 0n;
  let openCount = 0;

  for (const row of withdrawals) {
    const id = requiredText(row.id, "withdrawal.id");
    const stakeId = requiredText(row.stake_id, "withdrawal.stake_id");
    const type = String(row.withdrawal_type ?? "").trim().toLowerCase();
    if (!["capital", "reward"].includes(type)) throw contractError("withdrawal.withdrawal_type is invalid.");
    const status = normalizeStatus(row.status, ALL_WITHDRAWAL_STATUSES, "withdrawal.status");
    if (row.requested_amount === null || row.requested_amount === undefined || row.requested_amount === "") {
      throw contractError("withdrawal.requested_amount is missing.");
    }
    const requested = toUnits(row.requested_amount, "withdrawal.requested_amount");
    const fee = toUnits(row.fee_amount, "withdrawal.fee_amount");
    const receiveAmount = row.net_amount === null || row.net_amount === undefined
      ? requested
      : toUnits(row.net_amount, "withdrawal.net_amount");
    const compositeKey = keyFor(stakeId, type);

    if (RESERVED_WITHDRAWAL_STATUSES.has(status)) {
      deductions.set(compositeKey, (deductions.get(compositeKey) || 0n) + requested + fee);
    }
    if (IN_PROGRESS_WITHDRAWAL_STATUSES.has(status)) {
      openCount += 1;
      pendingToUser += receiveAmount;
      pendingFee += fee;
      pendingTotalDeduction += requested + fee;
      if (!openStatuses.has(compositeKey)) openStatuses.set(compositeKey, new Set());
      openStatuses.get(compositeKey).add(status);
    }
    if (status === "paid") {
      paidToUser += receiveAmount;
      paidFee += fee;
    }

    safeWithdrawals.push({
      id,
      stake_id: stakeId,
      project_code: row.project_code == null ? null : String(row.project_code),
      withdrawal_type: type,
      requested_amount_pi: fromUnits(requested),
      fee_amount_pi: fromUnits(fee),
      net_amount_pi: fromUnits(receiveAmount),
      status,
      txid: row.txid == null ? null : String(row.txid),
      created_at: safeDate(row.created_at),
      updated_at: safeDate(row.updated_at)
    });
  }

  const destination = String(registeredWalletAddress ?? "").trim();
  const destinationPresent = Boolean(destination);
  const canRequestInPrinciple = destinationPresent;

  let totalPrincipal = 0n;
  let activePrincipal = 0n;
  let recordedRewards = 0n;
  let capitalRequestable = 0n;
  let rewardRequestable = 0n;
  let withheldClosedPositionRewards = 0n;

  const publicPositions = positions.map((position) => {
    const p = position;
    totalPrincipal += p.principal_units;
    if (["active", "matured"].includes(p.status)) activePrincipal += p.principal_units;
    if (p.status !== "cancelled") recordedRewards += p.reward_units;

    const capitalDeduction = deductions.get(keyFor(p.stake_id, "capital")) || 0n;
    const rewardDeduction = deductions.get(keyFor(p.stake_id, "reward")) || 0n;
    const capitalRemaining = nonNegativeDifference(p.principal_units, capitalDeduction);
    const rewardRemaining = nonNegativeDifference(p.reward_units, rewardDeduction);
    const issues = [];
    let capitalRequest = 0n;
    let rewardRequest = 0n;

    if (p.status === "capital_withdrawn" && rewardRemaining > 0n) {
      withheldClosedPositionRewards += rewardRemaining;
      issues.push("capital_withdrawn_reward_review_required");
    }
    if (p.status === "active" || p.status === "matured") {
      if (!p.unlock_at) issues.push("unlock_date_missing_or_invalid");
      else if (!p.can_use_position) issues.push("position_not_matured");
      if (!destinationPresent) issues.push("registered_wallet_address_missing");
      if (p.can_use_position && canRequestInPrinciple && capitalRemaining > 0n) capitalRequest = capitalRemaining;
      if (p.can_use_position && canRequestInPrinciple && rewardRemaining > 0n) rewardRequest = rewardRemaining;
    }

    capitalRequestable += capitalRequest;
    rewardRequestable += rewardRequest;
    const capitalKey = keyFor(p.stake_id, "capital");
    const rewardKey = keyFor(p.stake_id, "reward");

    return {
      stake_id: p.stake_id,
      project_code: p.project_code,
      status: p.status,
      principal_pi: fromUnits(p.principal_units),
      recorded_reward_pi: fromUnits(p.reward_units),
      started_at: p.started_at,
      unlock_at: p.unlock_at,
      is_matured: p.can_use_position,
      capital_remaining_after_existing_requests_pi: fromUnits(capitalRemaining),
      reward_remaining_after_existing_requests_pi: fromUnits(rewardRemaining),
      capital_requestable_pi: fromUnits(capitalRequest),
      reward_requestable_pi: fromUnits(rewardRequest),
      open_capital_request_statuses: Array.from(openStatuses.get(capitalKey) || []),
      open_reward_request_statuses: Array.from(openStatuses.get(rewardKey) || []),
      eligibility_issue_codes: issues
    };
  });

  return {
    contract_version: "ALBUKHR_WALLET_BALANCE_V1",
    network: MAINNET,
    asset: "PI",
    as_of: new Date(nowMs).toISOString(),
    balance_semantics: {
      total_invested_principal_pi: "Recorded principal amounts on stake rows; not a Pi blockchain wallet balance.",
      recorded_reward_total_pi: "Recorded stake rewards excluding cancelled positions; not necessarily liquid or claimable.",
      total_requestable_pi: "Eligible amount after existing withdrawal deductions and destination presence checks; not spendable cash or a guaranteed payout.",
      withdrawal_deduction_rule: "requested_amount + fee_amount for pending, approved, and paid requests; rejected and cancelled requests do not reserve balance."
    },
    summary: {
      total_invested_principal_pi: fromUnits(totalPrincipal),
      active_principal_recorded_pi: fromUnits(activePrincipal),
      recorded_reward_total_pi: fromUnits(recordedRewards),
      matured_capital_requestable_pi: fromUnits(capitalRequestable),
      matured_reward_requestable_pi: fromUnits(rewardRequestable),
      total_requestable_pi: fromUnits(capitalRequestable + rewardRequestable),
      pending_withdrawal_to_user_pi: fromUnits(pendingToUser),
      pending_withdrawal_fee_pi: fromUnits(pendingFee),
      pending_total_deduction_pi: fromUnits(pendingTotalDeduction),
      withdrawals_paid_to_user_pi: fromUnits(paidToUser),
      withdrawal_fees_paid_pi: fromUnits(paidFee),
      open_withdrawal_requests_count: openCount,
      closed_position_rewards_held_for_review_pi: fromUnits(withheldClosedPositionRewards)
    },
    withdrawal_destination: {
      registered_address: destination || null,
      status: destinationPresent ? "registered_address_present" : "missing",
      current_pi_sdk_session_match: "not_verified_by_this_endpoint",
      client_session_comparison_required: true,
      note: "The existing withdrawal RPC uses the database-registered address. This endpoint does not prove it matches the current Pi SDK session or authorize any payout."
    },
    positions: publicPositions,
    recent_withdrawals: safeWithdrawals.slice(0, 10)
  };
}

module.exports = { buildWalletSnapshot, toUnits, fromUnits, MAINNET };
