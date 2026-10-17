"use strict";

/* Finance/Super Admin authenticated read-only A2U inspection endpoint. */
const crypto = require("node:crypto");
const express = require("express");
const { inspectA2UWithdrawal, UUID_RE } = require("./a2u-reconciliation-service");

function readAal(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || !claims.sub || !Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= Math.floor(Date.now() / 1000)) return null;
    return { sub: String(claims.sub), aal: String(claims.aal || "") };
  } catch { return null; }
}

function safeCode(error) {
  return String(error?.code || "A2U_RECONCILIATION_FAILED").replace(/[^A-Z0-9_]/gi, "").slice(0, 80);
}

function createA2UReconciliationRouter({ database } = {}) {
  const db = database || require("./supabase-client").supabase;
  const router = express.Router();

  router.post("/api/a2u/reconcile-inspect", async (req, res) => {
    try {
    const authorization = String(req.headers.authorization || "").trim();
    if (!/^Bearer\s+/i.test(authorization)) {
      return res.status(401).json({ success: false, code: "ADMIN_BEARER_REQUIRED" });
    }
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    if (!token) return res.status(401).json({ success: false, code: "ADMIN_BEARER_REQUIRED" });

    // Supabase Auth validates the exact JWT before its claims are used.
    const authResult = await db.auth.getUser(token).catch(() => ({ data: null, error: true }));
    const user = authResult?.data?.user;
    const claims = readAal(token);
    if (authResult?.error || !user || !claims || claims.sub !== String(user.id)) {
      return res.status(401).json({ success: false, code: "ADMIN_SESSION_INVALID" });
    }
    if (claims.aal !== "aal2") return res.status(403).json({ success: false, code: "AAL2_REQUIRED" });

    const adminResult = await db.schema("albukhr_security").from("admin_users")
      .select("user_id,status,mfa_required")
      .eq("user_id", user.id).eq("status", "active").maybeSingle();
    if (adminResult.error || !adminResult.data) {
      return res.status(403).json({ success: false, code: "ACTIVE_ADMIN_REQUIRED" });
    }
    const rolesResult = await db.schema("albukhr_security").from("admin_role_assignments")
      .select("role")
      .eq("user_id", user.id).eq("active", true).is("revoked_at", null)
      .in("role", ["super_admin", "finance_admin"]);
    const roles = Array.isArray(rolesResult.data) ? rolesResult.data.map((row) => String(row.role)) : [];
    if (rolesResult.error || !roles.length) {
      return res.status(403).json({ success: false, code: "FINANCE_OR_SUPER_ADMIN_REQUIRED" });
    }

    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const withdrawalRequestId = String(body.withdrawal_request_id || "").trim();
    if (!UUID_RE.test(withdrawalRequestId)) {
      return res.status(400).json({ success: false, code: "WITHDRAWAL_ID_INVALID" });
    }

    let result;
    try {
      result = await inspectA2UWithdrawal({ withdrawalRequestId, database: db });
    } catch (error) {
      // Avoid returning or logging tokens, API keys or raw Pi DTOs.
      const status = Number(error?.status) || 502;
      return res.status(status).json({ success: false, code: safeCode(error), error: status >= 500 ? "Read-only Pi reconciliation inspection failed." : String(error.message || "Invalid request.") });
    }

    const actorRole = roles.includes("super_admin") ? "super_admin" : "finance_admin";
    const audit = await db.schema("albukhr_security").from("admin_audit_log").insert({
      actor_user_id: user.id,
      action: "withdrawal_a2u_reconciliation_inspected",
      role: actorRole,
      target_table: "public.withdrawal_requests",
      target_id: withdrawalRequestId,
      request_id: crypto.randomUUID(),
      success: true,
      details: {
        network: "mainnet",
        classification: result.classification,
        payment_id: result.payment_id || null,
        transaction_id: result.transaction_id || null,
        evidence_sha256: result.evidence_sha256 || null,
        safe_to_mark_paid_automatically: false,
        safe_to_release_manual_payout: false
      }
    });
    if (audit.error) {
      return res.status(502).json({ success: false, code: "RECONCILIATION_AUDIT_WRITE_FAILED", error: "Inspection was not released to the caller because the finance audit event could not be recorded." });
    }

    return res.status(200).json({ success: true, network: "mainnet", data: result });
    } catch (error) {
      const status = Number(error?.status) || 500;
      return res.status(status).json({
        success: false,
        code: safeCode(error),
        error: status >= 500 ? "A2U reconciliation endpoint failed closed." : String(error?.message || "Invalid request.")
      });
    }
  });

  return router;
}

const a2uReconciliationRouter = createA2UReconciliationRouter();
module.exports = { createA2UReconciliationRouter, a2uReconciliationRouter };
