/* ALBUKHR — Contributor Internal Liquidity Gateway v1
 * Mainnet-only. Dedicated from Core Financial and Internal Investment gateways.
 *
 * Funding/Liquidity model:
 * - Contributor does NOT define the authoritative liquidity requirement.
 * - Funding assessment determines the system-recommended liquidity.
 * - Admin approves the system recommendation.
 * - Treasury stores the approved required_liquidity.
 * - This gateway computes the remaining liquidity gap server-side.
 * - Client-supplied amount must exactly match the current server-computed gap.
 */
"use strict";

const express = require("express");
const { supabase } = require("./supabase-client");
const {
  getPayment,
  approvePayment,
  completePayment,
  getPioneer
} = require("./pi-client");

const router = express.Router();

const MAINNET = "mainnet";
const INTERNAL_ACTION = "add_liquidity";
const INTERNAL_LIQUIDITY_ENGINE = "CONTRIBUTOR_INTERNAL_LIQUIDITY_V1";

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function body(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
}

function clean(value, field, max = 200) {
  const text = String(value || "").trim();

  if (!text || text.length > max) {
    throw httpError(400, `${field} is invalid.`);
  }

  return text;
}

function positiveAmount(value) {
  const amount = Number(value);

  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 1_000_000_000
  ) {
    throw httpError(400, "amount is invalid.");
  }

  return amount;
}

function normalizeAmount(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  return amount;
}

function requireBearer(req) {
  const header = String(req.headers.authorization || "").trim();

  if (!header.toLowerCase().startsWith("bearer ")) {
    throw httpError(401, "Pi authentication token is required.");
  }

  const token = header.slice(7).trim();

  if (!token) {
    throw httpError(401, "Pi authentication token is required.");
  }

  return token;
}

async function verifiedPiIdentity(req) {
  const token = requireBearer(req);
  const pioneer = await getPioneer(token);
  const piUid = String(pioneer.uid || "").trim();

  if (!piUid) {
    throw httpError(401, "Pi identity could not be verified.");
  }

  return {
    pi_uid: piUid
  };
}

async function getInternalProject(projectCode) {
  const { data, error } = await supabase
    .from("projects")
    .select(
      "id,project_code,project_type,status,network,registration_source,owner_albukhr_user_id"
    )
    .eq("project_code", projectCode)
    .eq("network", MAINNET)
    .maybeSingle();

  if (error) {
    throw httpError(502, "ALBUKHR project lookup failed.");
  }

  if (!data) {
    throw httpError(404, "Mainnet project was not found.");
  }

  if (
    String(data.project_type || "").toLowerCase() !== "internal" ||
    String(data.registration_source || "").toLowerCase() !==
      "contributor_internal"
  ) {
    throw httpError(
      403,
      "This route is only for Contributor Internal Projects."
    );
  }

  if (
    String(data.network || "").toLowerCase() !== MAINNET
  ) {
    throw httpError(
      403,
      "Only Mainnet Internal Projects are accepted."
    );
  }

  const status = String(data.status || "").toLowerCase();

  if (!["approved", "active"].includes(status)) {
    throw httpError(
      403,
      "Internal Project is not eligible for liquidity processing."
    );
  }

  return data;
}

async function assertContributorOwner(project, piUid) {
  if (!project?.owner_albukhr_user_id) {
    throw httpError(
      409,
      "Internal Project Contributor owner is not configured."
    );
  }

  const { data, error } = await supabase
    .from("users")
    .select("id,pi_uid,network")
    .eq("id", project.owner_albukhr_user_id)
    .eq("network", MAINNET)
    .maybeSingle();

  if (error) {
    throw httpError(502, "Contributor owner lookup failed.");
  }

  if (
    !data ||
    String(data.pi_uid || "") !== String(piUid || "") ||
    String(data.network || "").toLowerCase() !== MAINNET
  ) {
    throw httpError(
      403,
      "Only the Contributor owner can manage Internal Project liquidity."
    );
  }

  return data;
}

async function getInternalTreasury(projectId) {
  const { data, error } = await supabase
    .from("internal_project_treasury")
    .select(
      "id,treasury_wallet,required_liquidity,verified_liquidity,status,network"
    )
    .eq("project_id", projectId)
    .eq("network", MAINNET)
    .maybeSingle();

  if (error) {
    throw httpError(
      502,
      "ALBUKHR Internal treasury lookup failed."
    );
  }

  if (!data) {
    throw httpError(
      409,
      "Internal Project treasury is not configured."
    );
  }

  if (!data.treasury_wallet) {
    throw httpError(
      409,
      "Internal Project treasury wallet is missing."
    );
  }

  if (
    String(data.network || "").toLowerCase() !== MAINNET
  ) {
    throw httpError(
      403,
      "Only Mainnet Internal treasury is accepted."
    );
  }

  if (
    !["active", "locked"].includes(
      String(data.status || "").toLowerCase()
    )
  ) {
    throw httpError(
      409,
      "Internal Project treasury is not active."
    );
  }

  return data;
}

function paymentStatus(payment) {
  const status = payment?.status;

  if (status && typeof status === "object") {
    if (status.cancelled || status.user_cancelled) {
      return "cancelled";
    }

    if (status.developer_completed) {
      return "completed";
    }

    if (status.developer_approved) {
      return "approved";
    }

    return "pending";
  }

  return String(
    status ||
    payment?.transaction?.status ||
    ""
  )
    .trim()
    .toLowerCase();
}

function paymentRecipient(payment) {
  return String(
    payment?.to_address ||
    payment?.recipient_address ||
    payment?.recipient?.address ||
    payment?.transaction?.to_address ||
    ""
  ).trim();
}

function paymentSenderUid(payment) {
  return String(
    payment?.user_uid ||
    payment?.from_uid ||
    payment?.sender_uid ||
    payment?.sender?.uid ||
    ""
  ).trim();
}

function assertSender(payment, piUid) {
  const sender = paymentSenderUid(payment);

  if (sender && sender !== piUid) {
    throw httpError(
      403,
      "Pi payment sender does not match the authenticated Pi account."
    );
  }
}

function verifyInternalLiquidityPayment(
  payment,
  { project, treasury, piUid, amount }
) {
  const status = paymentStatus(payment);

  if (
    ![
      "created",
      "pending",
      "approved",
      "completed"
    ].includes(status)
  ) {
    throw httpError(
      409,
      "Pi liquidity payment is not in a valid processing state."
    );
  }

  const paymentAmount = Number(payment?.amount);

  if (
    !Number.isFinite(paymentAmount) ||
    paymentAmount !== amount
  ) {
    throw httpError(
      400,
      "Pi liquidity payment amount does not match the requested amount."
    );
  }

  assertSender(payment, piUid);

  const metadata = payment?.metadata || {};

  if (
    String(metadata.network || "").toLowerCase() !== MAINNET
  ) {
    throw httpError(
      403,
      "Only Mainnet liquidity payments are accepted."
    );
  }

  if (
    String(metadata.action || "").toLowerCase() !==
    INTERNAL_ACTION
  ) {
    throw httpError(
      403,
      "Unsupported Internal liquidity payment action."
    );
  }

  if (
    String(metadata.project_code || "") !==
    String(project.project_code || "")
  ) {
    throw httpError(
      403,
      "Pi payment project does not match the Internal Project."
    );
  }

  const recipient = paymentRecipient(payment);

  if (
    recipient &&
    recipient !== treasury.treasury_wallet
  ) {
    throw httpError(
      403,
      "Pi payment recipient does not match the Internal Project treasury wallet."
    );
  }

  return {
    status,
    recipient
  };
}

async function getWorkspace(project, piUid) {
  const { data, error } = await supabase.rpc(
    "get_internal_project_liquidity_workspace",
    {
      p_project_id: project.id,
      p_payer_pi_uid: piUid
    }
  );

  if (error) {
    console.error(
      "[ALBUKHR API] Internal liquidity workspace RPC failed",
      {
        code: error.code,
        message: error.message
      }
    );

    throw httpError(
      502,
      "Internal liquidity workspace is unavailable."
    );
  }

  return data;
}

/**
 * Resolve the authoritative remaining liquidity amount.
 *
 * The client may submit an amount as part of the payment flow, but
 * the API never trusts it as the source of truth.
 *
 * The authoritative amount comes from the server-side workspace:
 *
 *   required_liquidity - verified_liquidity
 *
 * The underlying settlement RPC independently repeats this protection,
 * so this gateway is not the only security boundary.
 */
async function getServerComputedLiquidityGap(project, piUid) {
  const workspace = await getWorkspace(
    project,
    piUid
  );

  if (!workspace || typeof workspace !== "object") {
    throw httpError(
      409,
      "Internal Project liquidity workspace is not ready."
    );
  }

  const requiredLiquidity = normalizeAmount(
    workspace.required_liquidity
  );

  const verifiedLiquidity = normalizeAmount(
    workspace.verified_liquidity
  );

  const workspaceGap = normalizeAmount(
    workspace.liquidity_gap
  );

  if (
    requiredLiquidity === null ||
    verifiedLiquidity === null
  ) {
    throw httpError(
      409,
      "Internal Project required and verified liquidity are not ready."
    );
  }

  const calculatedGap = Math.max(
    0,
    requiredLiquidity - verifiedLiquidity
  );

  /*
   * Prefer the server-returned liquidity_gap when present, but
   * independently calculate the same value to detect an inconsistent
   * workspace response.
   */
  if (
    workspaceGap !== null &&
    Math.abs(workspaceGap - calculatedGap) > 0.000000001
  ) {
    console.error(
      "[ALBUKHR API] Internal liquidity workspace gap mismatch",
      {
        project_id: project.id,
        required_liquidity: requiredLiquidity,
        verified_liquidity: verifiedLiquidity,
        workspace_gap: workspaceGap,
        calculated_gap: calculatedGap
      }
    );

    throw httpError(
      502,
      "Internal Project liquidity workspace returned an inconsistent liquidity gap."
    );
  }

  return {
    workspace,
    required_liquidity: requiredLiquidity,
    verified_liquidity: verifiedLiquidity,
    liquidity_gap: calculatedGap
  };
}

/**
 * Require a payment amount to match the current server-authoritative
 * remaining liquidity gap.
 *
 * This prevents:
 * - arbitrary Contributor-selected liquidity
 * - stale frontend amounts
 * - overfunding through this route
 * - funding beyond the currently approved requirement
 */
async function assertServerAuthoritativeLiquidityAmount(
  project,
  piUid,
  requestedAmount
) {
  const amount = positiveAmount(requestedAmount);

  const liquidity = await getServerComputedLiquidityGap(
    project,
    piUid
  );

  if (liquidity.liquidity_gap <= 0) {
    throw httpError(
      409,
      "Internal Project liquidity requirement has already been fully verified."
    );
  }

  if (
    Math.abs(amount - liquidity.liquidity_gap) >
    0.000000001
  ) {
    throw httpError(
      409,
      "Liquidity amount does not match the current server-approved remaining liquidity requirement."
    );
  }

  return {
    amount,
    ...liquidity
  };
}

router.get(
  "/api/internal-liquidity-workspace",
  async (req, res) => {
    try {
      const identity = await verifiedPiIdentity(req);

      const projectCode = clean(
        req.query.project_code,
        "project_code",
        100
      );

      const project = await getInternalProject(
        projectCode
      );

      await assertContributorOwner(
        project,
        identity.pi_uid
      );

      const workspace = await getWorkspace(
        project,
        identity.pi_uid
      );

      return res.status(200).json({
        success: true,
        data: workspace
      });
    } catch (error) {
      const status = Number(error?.status) || 500;

      if (status >= 500) {
        console.error(
          "[ALBUKHR API] Internal liquidity workspace error",
          error
        );
      }

      return res.status(status).json({
        success: false,
        error:
          status >= 500
            ? "Unable to load Internal liquidity workspace."
            : error.message
      });
    }
  }
);

router.get(
  "/api/internal-liquidity-history",
  async (req, res) => {
    try {
      const identity = await verifiedPiIdentity(req);

      const projectCode = clean(
        req.query.project_code,
        "project_code",
        100
      );

      const project = await getInternalProject(
        projectCode
      );

      await assertContributorOwner(
        project,
        identity.pi_uid
      );

      const [
        paymentsResult,
        transactionsResult
      ] = await Promise.all([
        supabase
          .from("internal_project_liquidity_payments")
          .select(
            "id,payment_id,amount,recipient_wallet,network,action,pi_status," +
              "verification_status,verified_at,verification_reference,created_at,updated_at"
          )
          .eq("project_id", project.id)
          .eq("network", MAINNET)
          .order("created_at", {
            ascending: false
          })
          .limit(100),

        supabase
          .from("internal_project_treasury_transactions")
          .select(
            "id,project_id,payment_id,transaction_type,amount,balance_after," +
              "reference,network,metadata,created_at"
          )
          .eq("project_id", project.id)
          .eq("network", MAINNET)
          .order("created_at", {
            ascending: false
          })
          .limit(100)
      ]);

      if (
        paymentsResult.error ||
        transactionsResult.error
      ) {
        throw httpError(
          502,
          "Internal liquidity history could not be loaded."
        );
      }

      return res.status(200).json({
        success: true,
        data: {
          project_code: project.project_code,
          network: MAINNET,
          payments: paymentsResult.data || [],
          transactions:
            transactionsResult.data || []
        }
      });
    } catch (error) {
      const status = Number(error?.status) || 500;

      if (status >= 500) {
        console.error(
          "[ALBUKHR API] Internal liquidity history error",
          error
        );
      }

      return res.status(status).json({
        success: false,
        error:
          status >= 500
            ? "Unable to load Internal liquidity history."
            : error.message
      });
    }
  }
);

router.post(
  "/api/internal-liquidity-approve",
  async (req, res) => {
    try {
      const identity = await verifiedPiIdentity(req);
      const b = body(req);

      const projectCode = clean(
        b.project_code,
        "project_code",
        100
      );

      const paymentId = clean(
        b.payment_id,
        "payment_id",
        200
      );

      const amount = positiveAmount(b.amount);

      const project = await getInternalProject(
        projectCode
      );

      await assertContributorOwner(
        project,
        identity.pi_uid
      );

      const treasury = await getInternalTreasury(
        project.id
      );

      /*
       * Critical protection:
       * Recalculate the current approved liquidity gap from
       * server-side state before accepting the payment amount.
       */
      const authoritativeLiquidity =
        await assertServerAuthoritativeLiquidityAmount(
          project,
          identity.pi_uid,
          amount
        );

      const payment = await getPayment(
        paymentId
      );

      verifyInternalLiquidityPayment(payment, {
        project,
        treasury,
        piUid: identity.pi_uid,
        amount: authoritativeLiquidity.amount
      });

      const approval = await approvePayment(
        paymentId
      );

      return res.status(200).json({
        success: true,
        data: {
          payment_id: paymentId,
          project_code: project.project_code,
          engine: INTERNAL_LIQUIDITY_ENGINE,
          amount: authoritativeLiquidity.amount,
          required_liquidity:
            authoritativeLiquidity.required_liquidity,
          verified_liquidity:
            authoritativeLiquidity.verified_liquidity,
          liquidity_gap:
            authoritativeLiquidity.liquidity_gap,
          approval
        }
      });
    } catch (error) {
      const status = Number(error?.status) || 500;

      if (status >= 500) {
        console.error(
          "[ALBUKHR API] Internal liquidity approval error",
          error
        );
      }

      return res.status(status).json({
        success: false,
        error:
          status >= 500
            ? "Internal liquidity payment approval failed."
            : error.message
      });
    }
  }
);

router.post(
  "/api/internal-liquidity-complete",
  async (req, res) => {
    try {
      const identity = await verifiedPiIdentity(req);
      const b = body(req);

      const projectCode = clean(
        b.project_code,
        "project_code",
        100
      );

      const paymentId = clean(
        b.payment_id,
        "payment_id",
        200
      );

      const txid = clean(
        b.txid,
        "txid",
        300
      );

      const amount = positiveAmount(b.amount);

      const project = await getInternalProject(
        projectCode
      );

      await assertContributorOwner(
        project,
        identity.pi_uid
      );

      const treasury = await getInternalTreasury(
        project.id
      );

      /*
       * Recalculate the server-authoritative gap BEFORE completing
       * the Pi payment.
       *
       * This prevents completion using a stale or arbitrary amount.
       */
      const authoritativeLiquidity =
        await assertServerAuthoritativeLiquidityAmount(
          project,
          identity.pi_uid,
          amount
        );

      const before = await getPayment(
        paymentId
      );

      verifyInternalLiquidityPayment(before, {
        project,
        treasury,
        piUid: identity.pi_uid,
        amount: authoritativeLiquidity.amount
      });

      await completePayment(
        paymentId,
        txid
      );

      const after = await getPayment(
        paymentId
      );

      const finalStatus = paymentStatus(
        after
      );

      if (finalStatus !== "completed") {
        throw httpError(
          409,
          "Pi liquidity payment was not confirmed as completed."
        );
      }

      /*
       * Verify the completed Pi payment again.
       */
      verifyInternalLiquidityPayment(after, {
        project,
        treasury,
        piUid: identity.pi_uid,
        amount: authoritativeLiquidity.amount
      });

      const recipient = paymentRecipient(
        after
      );

      if (
        !recipient ||
        recipient !== treasury.treasury_wallet
      ) {
        throw httpError(
          403,
          "Completed Pi payment recipient does not match the Internal Project treasury wallet."
        );
      }

      const transactionId = String(
        after?.transaction?.txid ||
          after?.transaction?.id ||
          txid
      ).trim();

      if (!transactionId) {
        throw httpError(
          502,
          "Completed Pi liquidity payment has no transaction id."
        );
      }

      /*
       * Final settlement remains server-authoritative.
       *
       * The settlement RPC independently verifies:
       * - project ownership
       * - treasury
       * - recipient
       * - required liquidity
       * - verified liquidity
       * - remaining gap
       * - exact payment amount
       *
       * Therefore this API layer and the database settlement layer
       * both enforce the same economic boundary.
       */
      const {
        data,
        error
      } = await supabase.rpc(
        "settle_internal_project_liquidity_payment",
        {
          p_project_id: project.id,
          p_payment_id: paymentId,
          p_payer_pi_uid: identity.pi_uid,
          p_amount: authoritativeLiquidity.amount,
          p_recipient_wallet: recipient,
          p_pi_status: finalStatus,
          p_verification_reference: transactionId,
          p_request_id: null,
          p_metadata: {
            source: "albukhr-api",
            engine: INTERNAL_LIQUIDITY_ENGINE,
            project_code: project.project_code,
            project_type: "internal",
            registration_source:
              "contributor_internal",
            network: MAINNET,
            transaction_id: transactionId,
            settlement_amount_source:
              "server_computed_remaining_gap"
          }
        }
      );

      if (error) {
        console.error(
          "[ALBUKHR API] Internal liquidity settlement RPC failed",
          {
            code: error.code,
            message: error.message
          }
        );

        throw httpError(
          502,
          "ALBUKHR Internal liquidity settlement failed."
        );
      }

      return res.status(200).json({
        success: true,
        data: {
          payment_id: paymentId,
          project_code: project.project_code,
          engine: INTERNAL_LIQUIDITY_ENGINE,
          amount: authoritativeLiquidity.amount,
          required_liquidity:
            authoritativeLiquidity.required_liquidity,
          verified_liquidity_before:
            authoritativeLiquidity.verified_liquidity,
          liquidity_gap_before:
            authoritativeLiquidity.liquidity_gap,
          completion: after,
          settlement: data
        }
      });
    } catch (error) {
      const status = Number(error?.status) || 500;

      if (status >= 500) {
        console.error(
          "[ALBUKHR API] Internal liquidity completion error",
          error
        );
      }

      return res.status(status).json({
        success: false,
        error:
          status >= 500
            ? "Internal liquidity payment completion failed."
            : error.message
      });
    }
  }
);

const internalLiquidityGatewayRouter =
  router;

module.exports = {
  internalLiquidityGatewayRouter
};
