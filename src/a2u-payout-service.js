"use strict";

/*
 * Single ALBUKHR A2U payout path. Do not enable on Mainnet until the Pi
 * documentation and launch authorization gate in pi-a2u-client.js are updated
 * through a separately reviewed change.
 */
const { supabase } = require("./supabase-client");
const StellarSdk = require("stellar-sdk");
const {
  a2uEnabled,
  createA2UPayment,
  getA2UPayment,
  getIncompleteA2UPayments,
  submitA2UPayment,
  completeA2UPayment
} = require("./pi-a2u-client");

const MAINNET = "mainnet";
const PI_MAINNET_NETWORK_LABEL = "Pi Network";
const WITHDRAWAL_FEE_RATE = 0.01;
const MAX_BATCH_SIZE = 20;
const DEFAULT_BATCH_SIZE = 5;
const activePayouts = new Set();

function httpError(status, message, code = null) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function requireA2UEnabled() {
  if (!a2uEnabled()) {
    throw httpError(
      503,
      "Pi A2U Mainnet payouts are disabled pending official Pi support and ALBUKHR approval.",
      "A2U_MAINNET_DISABLED"
    );
  }
}

function requiredText(value, field, max = 200) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw httpError(400, `${field} is invalid.`);
  return text;
}

function positiveAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    throw httpError(409, "Withdrawal amount is invalid.");
  }
  return amount;
}

function closeEnough(left, right) {
  return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) &&
    Math.abs(Number(left) - Number(right)) <= 1e-9;
}

function validPiAddress(value) {
  const address = String(value ?? "").trim();
  return address && StellarSdk.StrKey.isValidEd25519PublicKey(address);
}

async function claimPayout(withdrawalRequestId) {
  const { data, error } = await supabase.rpc("claim_a2u_withdrawal_payout_v2", {
    p_withdrawal_request_id: withdrawalRequestId
  });
  if (error) {
    throw httpError(502, "A2U payout claim failed.", "A2U_PAYOUT_CLAIM_FAILED");
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw httpError(502, "A2U payout claim returned no result.", "A2U_PAYOUT_CLAIM_EMPTY");
  return row;
}

async function recordProgress(
  attemptId,
  leaseToken,
  paymentId,
  txid = null,
  paymentCreationStarted = false,
  submissionStarted = false
) {
  const { data, error } = await supabase.rpc("record_a2u_withdrawal_payout_progress_v2", {
    p_attempt_id: attemptId,
    p_lease_token: leaseToken,
    p_payment_id: paymentId || null,
    p_txid: txid || null,
    p_payment_creation_started: paymentCreationStarted,
    p_submission_started: submissionStarted
  });
  if (error || data !== true) {
    throw httpError(409, "A2U payout progress could not be durably recorded; no further payment step will run.", "A2U_PROGRESS_NOT_RECORDED");
  }
}

async function markAttemptFailed(attemptId, leaseToken, error) {
  if (!attemptId || !leaseToken) return;
  const safeMessage = String(error?.code || error?.message || "A2U payout failed.").slice(0, 1500);
  const { error: rpcError } = await supabase.rpc("fail_a2u_withdrawal_payout_v2", {
    p_attempt_id: attemptId,
    p_lease_token: leaseToken,
    p_error: safeMessage
  });
  if (rpcError) {
    // Do not hide the original payment error or log secrets/authorization headers.
    console.error("[ALBUKHR A2U] Failed to release payout claim", {
      code: rpcError.code,
      message: rpcError.message
    });
  }
}

function validatePaymentDto(payment, expected) {
  if (!payment || typeof payment !== "object") {
    throw httpError(502, "Pi returned an invalid A2U payment object.", "A2U_PAYMENT_DTO_INVALID");
  }
  if (String(payment.identifier || "") !== expected.paymentId) {
    throw httpError(409, "Pi payment identifier does not match the stored payout.", "A2U_PAYMENT_ID_MISMATCH");
  }
  if (String(payment.user_uid || "") !== expected.piUid) {
    throw httpError(409, "Pi payment UID does not match the approved withdrawal.", "A2U_UID_MISMATCH");
  }
  if (!closeEnough(payment.amount, expected.amount)) {
    throw httpError(409, "Pi payment amount does not match the approved withdrawal.", "A2U_AMOUNT_MISMATCH");
  }
  if (String(payment.memo || "") !== expected.memo) {
    throw httpError(409, "Pi payment memo does not match the approved withdrawal.", "A2U_MEMO_MISMATCH");
  }
  if (String(payment.direction || "") !== "app_to_user") {
    throw httpError(409, "Pi payment direction is not app-to-user.", "A2U_DIRECTION_MISMATCH");
  }
  if (String(payment.network || "") !== PI_MAINNET_NETWORK_LABEL) {
    throw httpError(409, "Pi payment network is not confirmed as Pi Mainnet.", "A2U_NETWORK_MISMATCH");
  }
  const metadata = payment.metadata && typeof payment.metadata === "object" ? payment.metadata : {};
  if (String(metadata.withdrawal_request_id || "") !== expected.withdrawalRequestId ||
      String(metadata.network || "").toLowerCase() !== MAINNET ||
      String(metadata.source || "") !== "albukhr-api") {
    throw httpError(409, "Pi payment metadata does not match the approved ALBUKHR withdrawal.", "A2U_METADATA_MISMATCH");
  }
  const recipient = String(payment.to_address || "").trim();
  if (!validPiAddress(recipient)) {
    throw httpError(409, "Pi did not return a valid current recipient wallet address.", "A2U_RECIPIENT_INVALID");
  }
  if (payment.status?.cancelled || payment.status?.user_cancelled) {
    throw httpError(409, "Pi has cancelled this A2U payment.", "A2U_PAYMENT_CANCELLED");
  }
  return {
    recipient,
    transactionId: String(payment.transaction?.txid || "").trim(),
    transactionVerified: payment.status?.transaction_verified === true && payment.transaction?.verified === true,
    developerCompleted: payment.status?.developer_completed === true
  };
}

async function finalizePayout(attemptId, leaseToken, paymentId, txid) {
  const { data, error } = await supabase.rpc("finalize_a2u_withdrawal_payout_v2", {
    p_attempt_id: attemptId,
    p_lease_token: leaseToken,
    p_payment_id: paymentId,
    p_txid: txid
  });
  if (error || data !== true) {
    throw httpError(502, "Pi payment may be complete but ALBUKHR could not atomically finalize the withdrawal; retry/reconciliation is required.", "A2U_FINALIZATION_UNCONFIRMED");
  }
}

async function executeWithdrawalPayout(withdrawalRequestId) {
  requireA2UEnabled();
  const id = requiredText(withdrawalRequestId, "withdrawal_request_id", 100);
  if (activePayouts.has(id)) {
    throw httpError(409, "This withdrawal payout is already being processed in this API process.", "A2U_LOCAL_DUPLICATE");
  }
  activePayouts.add(id);

  let claim = null;
  try {
    const { data: request, error } = await supabase
      .from("withdrawal_requests")
      .select("id,stake_id,user_id,pi_uid,project_id,project_code,network,withdrawal_type,requested_amount,fee_rate,fee_amount,net_amount,wallet_address,status,txid")
      .eq("id", id)
      .eq("network", MAINNET)
      .maybeSingle();

    if (error) throw httpError(502, "Mainnet withdrawal request lookup failed.", "WITHDRAWAL_LOOKUP_FAILED");
    if (!request) throw httpError(404, "Mainnet withdrawal request was not found.", "WITHDRAWAL_NOT_FOUND");
    if (String(request.status || "").toLowerCase() === "paid" && request.txid) {
      return {
        already_paid: true,
        withdrawal_request_id: id,
        status: "paid",
        txid: request.txid,
        wallet_receive: Number(request.net_amount ?? request.requested_amount)
      };
    }
    if (String(request.status || "").toLowerCase() !== "approved") {
      throw httpError(409, "Only an approved withdrawal may enter the A2U payout worker.", "WITHDRAWAL_NOT_APPROVED");
    }

    const requestedAmount = positiveAmount(request.requested_amount);
    const walletReceive = Number(request.net_amount ?? request.requested_amount);
    const feeRate = Number(request.fee_rate ?? WITHDRAWAL_FEE_RATE);
    const feeAmount = Number(request.fee_amount ?? requestedAmount * feeRate);
    const totalDeduction = Number((requestedAmount + feeAmount).toFixed(3));
    if (!closeEnough(walletReceive, requestedAmount)) {
      throw httpError(409, "Withdrawal net amount contract is invalid.", "WITHDRAWAL_NET_AMOUNT_INVALID");
    }
    if (!closeEnough(feeRate, WITHDRAWAL_FEE_RATE)) {
      throw httpError(409, "Withdrawal fee policy differs from the currently reviewed payout contract.", "WITHDRAWAL_FEE_POLICY_MISMATCH");
    }
    if (!Number.isFinite(feeAmount) || feeAmount < 0 || !closeEnough(totalDeduction, requestedAmount + feeAmount)) {
      throw httpError(409, "Withdrawal fee amount is invalid.", "WITHDRAWAL_FEE_AMOUNT_INVALID");
    }

    const piUid = requiredText(request.pi_uid, "pi_uid", 200);
    const { data: stake, error: stakeError } = await supabase
      .from("stakes")
      .select("id,project_id,project_code,user_id,pi_uid,network,amount,duration_days,reward_amount,status,unlock_at")
      .eq("id", request.stake_id)
      .maybeSingle();
    if (stakeError) throw httpError(502, "Withdrawal stake lookup failed.", "WITHDRAWAL_STAKE_LOOKUP_FAILED");
    if (!stake || String(stake.network || "").toLowerCase() !== MAINNET) {
      throw httpError(409, "Withdrawal stake is missing or is not Mainnet.", "WITHDRAWAL_STAKE_NETWORK_INVALID");
    }
    if (String(stake.pi_uid || "") !== piUid || String(stake.user_id || "") !== String(request.user_id || "")) {
      throw httpError(409, "Withdrawal identity does not match the referenced stake.", "WITHDRAWAL_STAKE_IDENTITY_MISMATCH");
    }
    if (String(stake.project_id || "") !== String(request.project_id || "")) {
      throw httpError(409, "Withdrawal project does not match the referenced stake.", "WITHDRAWAL_PROJECT_MISMATCH");
    }

    const claimResult = await claimPayout(id);
    if (claimResult.claimed !== true) {
      // Never put a denied claim in `claim`: its catch handler must not release
      // another worker's active lease using a token returned for diagnostics.
      if (String(claimResult.reason || "") === "already_paid") {
        return { already_paid: true, withdrawal_request_id: id, status: "paid", txid: claimResult.txid || null };
      }
      throw httpError(409, `A2U payout claim was not granted (${String(claimResult.reason || "unknown")}).`, "A2U_PAYOUT_NOT_CLAIMED");
    }
    claim = claimResult;
    if (!claim.attempt_id || !claim.lease_token) {
      throw httpError(502, "A2U claim did not return a durable attempt and lease token.", "A2U_CLAIM_TOKEN_MISSING");
    }

    const expected = {
      withdrawalRequestId: id,
      piUid,
      amount: requestedAmount,
      memo: `ALBUKHR-WD:${id}`
    };
    let paymentId = String(claim.payment_id || "").trim();

    if (!paymentId) {
      const incomplete = await getIncompleteA2UPayments();
      const recovered = incomplete.find((item) =>
        String(item?.metadata?.withdrawal_request_id || "") === id &&
        String(item?.metadata?.source || "") === "albukhr-api"
      );
      if (recovered?.identifier) {
        paymentId = requiredText(recovered.identifier, "recovered A2U payment id", 200);
        // Persist a recovered ID before considering any blockchain operation.
        await recordProgress(claim.attempt_id, claim.lease_token, paymentId, null);
      } else if (claim.payment_creation_started_at) {
        // The create-payment request may have reached Pi even if the HTTP
        // response was lost. Never create a second payment automatically.
        throw httpError(
          409,
          "A previous Pi payment creation has an uncertain outcome; reconcile the incomplete-payment list before retrying.",
          "A2U_PAYMENT_CREATION_OUTCOME_UNCERTAIN"
        );
      } else if (incomplete.length > 0) {
        throw httpError(409, "Pi has an unrelated incomplete server payment; no new payment will be created until it is reconciled.", "A2U_UNRELATED_INCOMPLETE_PAYMENT");
      } else {
        // Persist the intent before the external call. If this call times out,
        // later attempts must reconcile instead of creating another Pi payment.
        await recordProgress(claim.attempt_id, claim.lease_token, null, null, true, false);
        const created = await createA2UPayment({
          uid: piUid,
          amount: requestedAmount,
          memo: expected.memo,
          metadata: {
            source: "albukhr-api",
            network: MAINNET,
            withdrawal_request_id: id,
            project_code: String(request.project_code || ""),
            withdrawal_type: String(request.withdrawal_type || ""),
            requested_amount: requestedAmount,
            fee_amount: feeAmount,
            total_deduction: totalDeduction,
            wallet_receive: walletReceive
          }
        });
        paymentId = requiredText(created.payment_id, "A2U payment id", 200);
        // Recording a payment ID clears the creation-in-flight marker.
        await recordProgress(claim.attempt_id, claim.lease_token, paymentId, null);
      }
    }

    let payment = await getA2UPayment(paymentId);
    let checked = validatePaymentDto(payment, { ...expected, paymentId });
    let paymentTxid = checked.transactionId;
    const claimedTxid = String(claim.txid || "").trim();
    if (claimedTxid && paymentTxid && claimedTxid !== paymentTxid) {
      throw httpError(409, "Stored A2U txid conflicts with Pi's payment record; stop for reconciliation.", "A2U_TXID_MISMATCH");
    }

    if (!paymentTxid) {
      if (claimedTxid) {
        throw httpError(409, "ALBUKHR has a stored txid but Pi has not returned its transaction; do not submit another payment.", "A2U_STORED_TXID_NOT_VISIBLE");
      }
      if (claim.submission_started_at) {
        // The prior worker may have submitted to Pi but lost the response.
        // Without a Pi transaction ID, fail closed for manual reconciliation.
        throw httpError(
          409,
          "A previous blockchain submission has an uncertain outcome; automatic resubmission is blocked until reconciliation.",
          "A2U_SUBMISSION_OUTCOME_UNCERTAIN"
        );
      }
      // Persist a submission-intent marker before the external blockchain call.
      // It is cleared only after a txid is durably stored.
      await recordProgress(claim.attempt_id, claim.lease_token, paymentId, null, false, true);
      paymentTxid = await submitA2UPayment(paymentId);
      // Persist the txid immediately after submission, before completion calls.
      await recordProgress(claim.attempt_id, claim.lease_token, paymentId, paymentTxid);
      payment = await getA2UPayment(paymentId);
      checked = validatePaymentDto(payment, { ...expected, paymentId });
      if (checked.transactionId && checked.transactionId !== paymentTxid) {
        throw httpError(409, "Pi transaction id differs from the persisted transaction id.", "A2U_SUBMITTED_TXID_MISMATCH");
      }
    } else {
      await recordProgress(claim.attempt_id, claim.lease_token, paymentId, paymentTxid);
    }

    if (!checked.transactionVerified) {
      throw httpError(409, "Pi has not yet verified the A2U blockchain transaction; the withdrawal remains unpaid and will need a later retry.", "A2U_TRANSACTION_NOT_VERIFIED");
    }
    if (String(checked.transactionId || paymentTxid) !== paymentTxid) {
      throw httpError(409, "Pi's verified transaction id does not match the stored transaction id.", "A2U_VERIFIED_TXID_MISMATCH");
    }

    if (!checked.developerCompleted) {
      await completeA2UPayment(paymentId, paymentTxid);
    }

    payment = await getA2UPayment(paymentId);
    checked = validatePaymentDto(payment, { ...expected, paymentId });
    if (!checked.transactionVerified || !checked.developerCompleted || checked.transactionId !== paymentTxid) {
      throw httpError(502, "Pi did not confirm a completed, verified A2U payment; ALBUKHR will not mark the withdrawal paid.", "A2U_FINAL_PI_VERIFICATION_FAILED");
    }

    await finalizePayout(claim.attempt_id, claim.lease_token, paymentId, paymentTxid);
    return {
      already_paid: false,
      withdrawal_request_id: id,
      status: "paid",
      payment_id: paymentId,
      txid: paymentTxid,
      wallet_receive: walletReceive,
      fee_amount: feeAmount,
      total_deduction: totalDeduction,
      recipient_wallet: checked.recipient
    };
  } catch (error) {
    await markAttemptFailed(claim?.attempt_id, claim?.lease_token, error);
    throw error;
  } finally {
    activePayouts.delete(id);
  }
}

async function processApprovedWithdrawals(batchSize = DEFAULT_BATCH_SIZE) {
  if (!a2uEnabled()) {
    return {
      network: MAINNET,
      disabled: true,
      selected: 0,
      processed: 0,
      failed: 0,
      skipped: 0,
      results: []
    };
  }

  const parsedSize = Number.parseInt(String(batchSize), 10);
  const limit = Number.isInteger(parsedSize) && parsedSize > 0
    ? Math.min(parsedSize, MAX_BATCH_SIZE)
    : DEFAULT_BATCH_SIZE;
  const { data, error } = await supabase.rpc("get_a2u_approved_withdrawal_queue", {
    p_batch_size: limit
  });
  if (error) {
    throw httpError(502, "Approved Mainnet A2U queue lookup failed.", "A2U_QUEUE_LOOKUP_FAILED");
  }
  const rows = Array.isArray(data) ? data : [];
  const results = [];

  // Sequential processing avoids concurrent operations on the single app wallet.
  for (const row of rows) {
    try {
      results.push(await executeWithdrawalPayout(row.id));
    } catch (error) {
      results.push({
        withdrawal_request_id: row.id,
        status: "failed",
        code: error?.code || "A2U_PAYOUT_FAILED",
        error: String(error?.message || "A2U payout failed.")
      });
    }
  }

  return {
    network: MAINNET,
    disabled: false,
    selected: rows.length,
    processed: results.filter((item) => item.status === "paid" && item.already_paid !== true).length,
    failed: results.filter((item) => item.status === "failed").length,
    skipped: results.filter((item) => item.already_paid === true).length,
    results
  };
}

module.exports = { executeWithdrawalPayout, processApprovedWithdrawals };
