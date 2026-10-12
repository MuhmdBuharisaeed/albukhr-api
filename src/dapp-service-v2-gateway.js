
"use strict";

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const MAIN = "https://ribpntyqdleytsyktdfb.supabase.co";
const PI = "https://api.minepi.com/v2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TXID = /^[a-f0-9]{64}$/i;

const STATUSES = new Set([
  "submitted",
  "under_review",
  "needs_information",
  "revision_requested",
  "quote_issued",
  "quote_accepted",
  "approved",
  "rejected",
  "queued",
  "in_progress",
  "delivered",
  "completed",
  "cancelled"
]);

const clean = (v, n = 1000) =>
  typeof v === "string"
    ? v.replace(/\0/g, "").trim().slice(0, n)
    : "";

const obj = v =>
  v && typeof v === "object" && !Array.isArray(v) ? v : {};

function readConfig(env = process.env) {
  const network = clean(env.DAPP_SERVICE_NETWORK, 20).toLowerCase();
  const url = clean(env.DAPP_SERVICE_SUPABASE_URL, 200).replace(/\/+$/, "");
  const key = clean(env.DAPP_SERVICE_SUPABASE_SERVICE_ROLE_KEY, 500);
  const anon = clean(env.DAPP_SERVICE_SUPABASE_ANON_KEY, 500);
  const piKey = clean(env.PI_API_KEY, 500);
  const base = clean(env.DAPP_SERVICE_PI_API_BASE, 200).replace(/\/+$/, "");

  if (network !== "mainnet" || url !== MAIN) {
    throw Error(
      "dApp service is Mainnet-only and requires the Mainnet Supabase project."
    );
  }

  if (!key) {
    throw Error("DAPP_SERVICE_SUPABASE_SERVICE_ROLE_KEY is required.");
  }

  if (base !== PI) {
    throw Error("DAPP_SERVICE_PI_API_BASE must equal https://api.minepi.com/v2.");
  }

  return {
    network,
    url,
    key,
    anon,
    piKey,
    base,
    consent: clean(env.DAPP_SERVICE_CONSENT_VERSION || "v1", 80),
    payments:
      String(env.DAPP_SERVICE_PI_PAYMENTS_ENABLED || "").toLowerCase() === "true" &&
      !!piKey
  };
}

const noStore = res => {
  res.set("Cache-Control", "no-store, max-age=0");
  res.set("Pragma", "no-cache");
};

const fail = (res, s, e) => {
  noStore(res);
  return res.status(s).json({ success: false, error: e });
};

const token = req => {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
};

const statusOf = e =>
  ({
    "42501": 403,
    P0002: 404,
    "22023": 400,
    "23514": 400,
    "23505": 409
  }[String(e?.code)] || 503);

const snap = p => ({
  identifier: clean(p?.identifier, 180),
  amount: Number(p?.amount),
  memo: clean(p?.memo, 500),
  metadata: obj(p?.metadata),
  from_uid: clean(p?.from_uid, 180) || null,
  network: clean(p?.network, 80) || null,
  status: obj(p?.status),
  transaction: p?.transaction
    ? {
        txid: clean(p.transaction.txid, 160) || null,
        verified: p.transaction.verified === true,
        link: clean(p.transaction._link, 500) || null
      }
    : null
});

function createDappServiceV2GatewayRouter(options = {}) {
  const c =
    options.config ||
    readConfig();

  const db =
    options.supabase ||
    createClient(c.url, c.key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });

  const r = express.Router();

  async function pioneer(req, res) {
    const t = token(req);

    if (!t) {
      fail(res, 401, "Pi authentication is required.");
      return null;
    }

    try {
      const x = await fetch(c.base + "/me", {
        headers: {
          Authorization: "Bearer " + t,
          Accept: "application/json"
        },
        cache: "no-store"
      });

      const u = await x.json().catch(() => null);

      if (!x.ok || !clean(u?.uid, 180)) {
        fail(res, 401, "Pi identity could not be verified.");
        return null;
      }

      return {
        uid: clean(u.uid, 180),
        username: clean(u.username, 100)
      };
    } catch (_) {
      fail(res, 503, "Pi identity service unavailable.");
      return null;
    }
  }

  async function admin(req, res) {
    const t = token(req);

    if (!t) {
      fail(res, 401, "Admin authentication required.");
      return null;
    }

    if (!c.anon) {
      fail(res, 503, "DAPP_SERVICE_SUPABASE_ANON_KEY missing.");
      return null;
    }

    try {
      const cl = createClient(c.url, c.anon, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        },
        global: {
          headers: {
            Authorization: "Bearer " + t
          }
        }
      });

      const u = await cl.auth.getUser(t);

      if (u.error || !u.data?.user?.id) {
        fail(res, 401, "Admin session invalid.");
        return null;
      }

      const z = await cl
        .schema("albukhr_security")
        .rpc("get_my_admin_context");

      const a = Array.isArray(z.data) ? z.data[0] : z.data;

      if (
        z.error ||
        !a ||
        a.is_admin !== true ||
        a.status !== "active" ||
        String(a.user_id) !== String(u.data.user.id) ||
        !Array.isArray(a.roles) ||
        !a.roles.some(x => ["super_admin", "external_admin"].includes(x))
      ) {
        fail(res, 403, "Active super_admin/external_admin role required.");
        return null;
      }

      if (a.mfa_required !== false) {
        let claims = {};

        try {
          claims = JSON.parse(
            Buffer.from(t.split(".")[1], "base64url").toString()
          );
        } catch (_) {}

        if (claims.aal !== "aal2") {
          fail(res, 403, "Admin MFA/AAL2 required.");
          return null;
        }
      }

      return { user: u.data.user };
    } catch (_) {
      fail(res, 503, "Admin authorization unavailable.");
      return null;
    }
  }

  async function pi(path, method = "GET", body) {
    if (!c.piKey) {
      throw Error("Pi API key missing.");
    }

    const x = await fetch(c.base + path, {
      method,
      headers: {
        Authorization: "Key " + c.piKey,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store"
    });

    const d = await x.json().catch(() => null);

    if (!x.ok) {
      throw Error("Pi Platform payment request failed.");
    }

    return d;
  }

  async function quoteFor(rid, qid, u) {
    const a = await db
      .from("dapp_service_requests")
      .select("id,network,applicant_pi_uid,request_status,payment_status")
      .eq("id", rid)
      .eq("network", "mainnet")
      .eq("applicant_pi_uid", u.uid)
      .maybeSingle();

    if (a.error) throw a.error;

    if (!a.data) {
      throw Object.assign(Error("Request not found."), { status: 404 });
    }

    const b = await db
      .from("dapp_service_quotes")
      .select(
        "id,request_id,version_number,quote_status,currency_or_asset,total_amount,valid_until"
      )
      .eq("id", qid)
      .eq("request_id", rid)
      .eq("network", "mainnet")
      .maybeSingle();

    if (b.error) throw b.error;

    if (!b.data) {
      throw Object.assign(Error("Quote not found."), { status: 404 });
    }

    if (
      a.data.request_status !== "quote_accepted" ||
      b.data.quote_status !== "accepted" ||
      b.data.currency_or_asset !== "PI" ||
      a.data.payment_status === "confirmed" ||
      !["unpaid", "cancelled", "failed", "pending_verification"].includes(
        a.data.payment_status
      ) ||
      Date.parse(b.data.valid_until) <= Date.now()
    ) {
      throw Object.assign(Error("Accepted quote is not payable."), {
        status: 409
      });
    }

    return {
      request: a.data,
      quote: b.data
    };
  }

  /*
   * Hardened Pi payment verification.
   * Require a finite positive amount, exact authenticated sender UID,
   * correct service/network/request/quote metadata and quote version.
   */
  function verify(p, id, u, req, q) {
    const m = obj(p?.metadata);

    const paymentAmount = Number(p?.amount);
    const quoteAmount = Number(q?.total_amount);
    const quoteVersion = Number(q?.version_number);
    const metadataVersion = Number(m.quote_version);

    const validAmounts =
      Number.isFinite(paymentAmount) &&
      paymentAmount > 0 &&
      Number.isFinite(quoteAmount) &&
      quoteAmount > 0 &&
      Math.abs(paymentAmount - quoteAmount) < 0.00000005;

    const validQuoteVersion =
      Number.isFinite(metadataVersion) &&
      Number.isFinite(quoteVersion) &&
      metadataVersion === quoteVersion;

    const validSender =
      typeof p?.from_uid === "string" &&
      p.from_uid.trim().length > 0 &&
      p.from_uid === u.uid;

    const validNetwork =
      !p?.network ||
      ["pi network", "mainnet"].includes(
        String(p.network).trim().toLowerCase()
      );

    if (
      String(p?.identifier) !== id ||
      !validAmounts ||
      m.service !== "albukhr_dapp_service_v1" ||
      m.network !== "mainnet" ||
      String(m.request_id) !== req.id ||
      String(m.quote_id) !== q.id ||
      !validQuoteVersion ||
      String(m.applicant_pi_uid) !== u.uid ||
      !validSender ||
      !validNetwork
    ) {
      throw Error(
        "Pi payment does not match authenticated applicant, amount, network and accepted quote."
      );
    }

    return snap(p);
  }

  r.get("/health", async (_q, s) => {
    const z = await db
      .from("dapp_service_requests")
      .select("id", { head: true, count: "exact" })
      .eq("network", "mainnet");

    if (z.error) {
      return fail(s, 503, "Database check failed.");
    }

    noStore(s);

    s.json({
      success: true,
      status: "ok",
      network: "mainnet",
      paymentChannels: {
        pi: c.payments,
        bankTransfer: false
      }
    });
  });

  r.get("/catalog", (_q, s) => {
    noStore(s);

    s.json({
      success: true,
      network: "mainnet",
      quoteRequired: true,
      paymentChannels: {
        pi: c.payments,
        bankTransfer: false
      },
      services: [
        { id: "pi_studio", title: "Pi Studio Assistance" },
        { id: "developer", title: "Developer-built dApp" }
      ]
    });
  });

  r.post("/requests", async (q, s) => {
    const u = await pioneer(q, s);
    if (!u) return;

    const b = obj(q.body);
    const project = clean(b.projectName, 120);
    const description = clean(b.description, 4000);
    const type = clean(b.serviceType, 40);

    if (
      b.consentAccepted !== true ||
      clean(b.consentVersion, 80) !== c.consent
    ) {
      return fail(s, 400, "Accept the current service terms.");
    }

    if (
      !project ||
      !description ||
      !["pi_studio", "developer"].includes(type)
    ) {
      return fail(
        s,
        400,
        "Project name, service type and description required."
      );
    }

    const z = await db
      .from("dapp_service_requests")
      .insert({
        network: "mainnet",
        applicant_pi_uid: u.uid,
        pi_username: u.username || null,
        project_name: project,
        service_type: type,
        description,
        consent_version: c.consent,
        request_status: "submitted",
        payment_status: "unpaid"
      })
      .select(
        "id,network,project_name,service_type,request_status,payment_status,created_at"
      )
      .single();

    if (z.error) {
      return fail(s, 503, "Request could not be saved.");
    }

    noStore(s);
    s.status(201).json({
      success: true,
      network: "mainnet",
      request: z.data
    });
  });

  r.get("/requests", async (q, s) => {
    const u = await pioneer(q, s);
    if (!u) return;

    const z = await db
      .from("dapp_service_requests")
      .select(
        "id,network,project_name,service_type,description,request_status,payment_status,created_at,updated_at"
      )
      .eq("network", "mainnet")
      .eq("applicant_pi_uid", u.uid)
      .order("created_at", { ascending: false })
      .limit(50);

    if (z.error) {
      return fail(s, 503, "History unavailable.");
    }

    const ids = (z.data || []).map(x => x.id);
    let qs = [];
    let ps = [];

    if (ids.length) {
      const a = await db
        .from("dapp_service_quotes")
        .select(
          "id,request_id,version_number,quote_status,currency_or_asset,scope_summary,out_of_scope,deliverables,total_amount,valid_until,terms_version,issued_at,accepted_at,declined_at"
        )
        .eq("network", "mainnet")
        .in("request_id", ids)
        .order("version_number", { ascending: false });

      const b = await db
        .from("dapp_service_payments")
        .select(
          "id,request_id,quote_id,payment_id,amount,currency_or_asset,payment_status,developer_approved,transaction_verified,developer_completed,txid,created_at"
        )
        .eq("network", "mainnet")
        .eq("applicant_pi_uid", u.uid)
        .in("request_id", ids)
        .order("created_at", { ascending: false });

      if (a.error || b.error) {
        return fail(s, 503, "Quote/payment history unavailable.");
      }

      qs = a.data || [];
      ps = b.data || [];
    }

    const qm = new Map();
    const pm = new Map();

    qs.forEach(x => {
      if (!qm.has(x.request_id)) qm.set(x.request_id, x);
    });

    ps.forEach(x => {
      if (!pm.has(x.request_id)) pm.set(x.request_id, x);
    });

    noStore(s);

    s.json({
      success: true,
      network: "mainnet",
      paymentChannels: {
        pi: c.payments,
        bankTransfer: false
      },
      requests: (z.data || []).map(x => ({
        ...x,
        latest_quote: qm.get(x.id) || null,
        latest_payment: pm.get(x.id) || null
      }))
    });
  });

  r.post("/requests/:requestId/quotes/:quoteId/respond", async (q, s) => {
    const u = await pioneer(q, s);
    if (!u) return;

    const rid = clean(q.params.requestId, 50);
    const qid = clean(q.params.quoteId, 50);
    const response = clean(q.body?.response, 20);

    if (
      !UUID.test(rid) ||
      !UUID.test(qid) ||
      !["accepted", "declined"].includes(response)
    ) {
      return fail(s, 400, "Invalid quote response.");
    }

    const z = await db.rpc("dapp_service_applicant_respond_to_quote", {
      p_request_id: rid,
      p_quote_id: qid,
      p_applicant_pi_uid: u.uid,
      p_response: response
    });

    if (z.error) {
      return fail(s, statusOf(z.error), "Quote response failed.");
    }

    noStore(s);
    s.json({
      success: true,
      network: "mainnet",
      result: z.data
    });
  });

  r.post("/payments/approve", async (q, s) => {
    const u = await pioneer(q, s);
    if (!u) return;

    if (!c.payments) {
      return fail(s, 503, "Pi payments are disabled.");
    }

    const id = clean(q.body?.paymentId, 180);
    const rid = clean(q.body?.requestId, 50);
    const qid = clean(q.body?.quoteId, 50);

    if (!id || !UUID.test(rid) || !UUID.test(qid)) {
      return fail(s, 400, "Payment, request and quote IDs required.");
    }

    try {
      const { request, quote } = await quoteFor(rid, qid, u);
      const p = await pi("/payments/" + encodeURIComponent(id));
      const ss = verify(p, id, u, request, quote);

      const prep = await db.rpc("dapp_service_prepare_pi_payment", {
        p_request_id: rid,
        p_quote_id: qid,
        p_payment_id: id,
        p_applicant_pi_uid: u.uid,
        p_amount: Number(quote.total_amount),
        p_memo: clean(p.memo, 500) || "ALBUKHR dApp service " + rid,
        p_pi_payment_snapshot: ss
      });

      if (prep.error) {
        return fail(s, statusOf(prep.error), "Payment could not be linked to quote.");
      }

      let approved = p;

      if (p.status?.developer_approved !== true) {
        await pi("/payments/" + encodeURIComponent(id) + "/approve", "POST", {});
        approved = await pi("/payments/" + encodeURIComponent(id));
      }

      if (approved.status?.developer_approved !== true) {
        return fail(s, 503, "Pi server approval not yet confirmed.");
      }

      const rec = await db.rpc("dapp_service_record_pi_approval", {
        p_payment_id: id,
        p_applicant_pi_uid: u.uid,
        p_pi_payment_snapshot: snap(approved)
      });

      if (rec.error) {
        return fail(s, 503, "Pi approved; retry callback to record approval.");
      }

      noStore(s);
      s.json({
        success: true,
        network: "mainnet",
        paymentId: id,
        paymentStatus: "approved"
      });
    } catch (e) {
      return fail(
        s,
        e.status === 404 ? 404 : e.status === 409 ? 409 : 503,
        "Pi approval could not be verified; retry callback."
      );
    }
  });

  r.post("/payments/complete", async (q, s) => {
    const u = await pioneer(q, s);
    if (!u) return;

    if (!c.payments) {
      return fail(s, 503, "Pi payments are disabled.");
    }

    const id = clean(q.body?.paymentId, 180);
    const txid = clean(q.body?.txid, 160);

    if (!id || !TXID.test(txid)) {
      return fail(s, 400, "Valid payment ID and txid required.");
    }

    try {
      const z = await db
        .from("dapp_service_payments")
        .select(
          "payment_id,request_id,quote_id,applicant_pi_uid,payment_status,txid"
        )
        .eq("network", "mainnet")
        .eq("payment_id", id)
        .eq("applicant_pi_uid", u.uid)
        .maybeSingle();

      if (z.error) throw z.error;

      if (!z.data) {
        return fail(s, 404, "Payment not linked to applicant.");
      }

      if (z.data.payment_status === "confirmed") {
        return z.data.txid?.toLowerCase() === txid.toLowerCase()
          ? s.json({
              success: true,
              network: "mainnet",
              paymentStatus: "confirmed",
              txid
            })
          : fail(s, 409, "Confirmed txid mismatch.");
      }

      const { request, quote } = await quoteFor(
        z.data.request_id,
        z.data.quote_id,
        u
      );

      let p = await pi("/payments/" + encodeURIComponent(id));
      verify(p, id, u, request, quote);

      if (p.status?.developer_approved !== true) {
        return fail(s, 409, "Pi approval is not confirmed.");
      }

      if (
        p.transaction?.txid &&
        p.transaction.txid.toLowerCase() !== txid.toLowerCase()
      ) {
        return fail(s, 409, "Pi txid mismatch.");
      }

      if (
        !(
          p.status?.developer_completed === true &&
          p.status?.transaction_verified === true &&
          p.transaction?.verified === true &&
          String(p.transaction?.txid || "").toLowerCase() === txid.toLowerCase()
        )
      ) {
        await pi("/payments/" + encodeURIComponent(id) + "/complete", "POST", {
          txid
        });

        p = await pi("/payments/" + encodeURIComponent(id));
      }

      if (
        !(
          p.status?.developer_completed === true &&
          p.status?.transaction_verified === true &&
          p.transaction?.verified === true &&
          String(p.transaction?.txid || "").toLowerCase() === txid.toLowerCase()
        )
      ) {
        return fail(
          s,
          503,
          "Pi transaction is not verified; payment remains unconfirmed."
        );
      }

      const done = await db.rpc("dapp_service_confirm_pi_payment", {
        p_payment_id: id,
        p_applicant_pi_uid: u.uid,
        p_txid: txid,
        p_transaction_verified: true,
        p_developer_completed: true,
        p_pi_payment_snapshot: snap(p)
      });

      if (done.error) {
        return fail(s, 503, "Pi verified; retry callback to record confirmation.");
      }

      noStore(s);

      s.json({
        success: true,
        network: "mainnet",
        paymentStatus: "confirmed",
        txid,
        result: done.data
      });
    } catch (_) {
      return fail(
        s,
        503,
        "Pi completion could not be verified; payment is not confirmed."
      );
    }
  });

  r.post("/payments/cancel", async (q, s) => {
    const u = await pioneer(q, s);
    if (!u) return;

    if (!c.payments) {
      return fail(s, 503, "Pi payments are disabled.");
    }

    const id = clean(q.body?.paymentId, 180);

    if (!id) {
      return fail(s, 400, "Payment ID required.");
    }

    try {
      const z = await db
        .from("dapp_service_payments")
        .select("payment_id,applicant_pi_uid,payment_status")
        .eq("network", "mainnet")
        .eq("payment_id", id)
        .maybeSingle();

      if (z.error) throw z.error;

      if (!z.data) {
        return s.json({
          success: true,
          network: "mainnet",
          skipped: true
        });
      }

      if (z.data.applicant_pi_uid !== u.uid) {
        return fail(s, 403, "Payment belongs to another user.");
      }

      if (z.data.payment_status === "confirmed") {
        return fail(s, 409, "Confirmed payment cannot be cancelled.");
      }

      const p = await pi("/payments/" + encodeURIComponent(id));

      if (p.transaction?.txid) {
        return fail(s, 409, "Pi reports a transaction; cannot cancel.");
      }

      const done = await db.rpc("dapp_service_fail_pi_payment", {
        p_payment_id: id,
        p_applicant_pi_uid: u.uid,
        p_result_status: "cancelled",
        p_reason: "Applicant cancelled payment flow",
        p_pi_payment_snapshot: snap(p)
      });

      if (done.error) {
        return fail(s, statusOf(done.error), "Cancellation record failed.");
      }

      noStore(s);

      s.json({
        success: true,
        network: "mainnet",
        paymentStatus: "cancelled"
      });
    } catch (_) {
      return fail(s, 503, "Cancellation could not be verified.");
    }
  });

  r.get("/admin/requests", async (q, s) => {
    if (!(await admin(q, s))) return;

    const st = clean(q.query.status, 40);

    if (st && !STATUSES.has(st)) {
      return fail(s, 400, "Unknown status.");
    }

    let b = db
      .from("dapp_service_requests")
      .select(
        "id,network,applicant_pi_uid,pi_username,project_name,service_type,description,consent_version,request_status,payment_status,created_at,updated_at"
      )
      .eq("network", "mainnet")
      .order("created_at", { ascending: false })
      .limit(100);

    if (st) b = b.eq("request_status", st);

    const z = await b;

    if (z.error) {
      return fail(s, 503, "Queue unavailable.");
    }

    noStore(s);

    s.json({
      success: true,
      network: "mainnet",
      requests: z.data || []
    });
  });

  r.get("/admin/requests/:requestId", async (q, s) => {
    if (!(await admin(q, s))) return;

    const id = clean(q.params.requestId, 50);

    if (!UUID.test(id)) {
      return fail(s, 400, "Invalid request ID.");
    }

    const a = await db
      .from("dapp_service_requests")
      .select(
        "id,network,applicant_pi_uid,pi_username,project_name,service_type,description,consent_version,request_status,payment_status,created_at,updated_at"
      )
      .eq("network", "mainnet")
      .eq("id", id)
      .maybeSingle();

    if (a.error) {
      return fail(s, 503, "Detail unavailable.");
    }

    if (!a.data) {
      return fail(s, 404, "Request not found.");
    }

    const [b, c1, d1] = await Promise.all([
      db
        .from("dapp_service_quotes")
        .select("*")
        .eq("network", "mainnet")
        .eq("request_id", id)
        .order("version_number", { ascending: false }),

      db
        .from("dapp_service_payments")
        .select(
          "id,quote_id,payment_id,amount,currency_or_asset,payment_status,developer_approved,transaction_verified,developer_completed,txid,created_at"
        )
        .eq("network", "mainnet")
        .eq("request_id", id)
        .order("created_at", { ascending: false }),

      db
        .from("dapp_service_audit_events")
        .select(
          "id,quote_id,actor_type,actor_id,event_type,previous_state,new_state,reason,created_at"
        )
        .eq("network", "mainnet")
        .eq("request_id", id)
        .order("created_at", { ascending: false })
        .limit(100)
    ]);

    if (b.error || c1.error || d1.error) {
      return fail(s, 503, "Detail data unavailable.");
    }

    noStore(s);

    s.json({
      success: true,
      network: "mainnet",
      request: a.data,
      quotes: b.data || [],
      payments: c1.data || [],
      auditEvents: d1.data || []
    });
  });

  r.post("/admin/requests/:requestId/status", async (q, s) => {
    const a = await admin(q, s);
    if (!a) return;

    const id = clean(q.params.requestId, 50);
    const target = clean(q.body?.target_status, 40);

    if (
      !UUID.test(id) ||
      ![
        "under_review",
        "needs_information",
        "revision_requested",
        "rejected",
        "cancelled",
        "approved",
        "queued",
        "in_progress",
        "delivered",
        "completed"
      ].includes(target)
    ) {
      return fail(s, 400, "Invalid transition.");
    }

    const z = await db.rpc("dapp_service_admin_transition_request", {
      p_request_id: id,
      p_admin_user_id: a.user.id,
      p_target_status: target,
      p_reason: clean(q.body?.reason, 1000) || null
    });

    if (z.error) {
      return fail(s, statusOf(z.error), "Status transition failed.");
    }

    noStore(s);

    s.json({
      success: true,
      network: "mainnet",
      result: z.data
    });
  });

  r.post("/admin/requests/:requestId/quotes", async (q, s) => {
    const a = await admin(q, s);
    if (!a) return;

    const id = clean(q.params.requestId, 50);
    const b = obj(q.body);
    const scope = clean(b.scope_summary, 6000);
    const terms = clean(b.terms_version, 100);
    const amount = Number(b.total_amount);
    const until = Date.parse(b.valid_until);

    const lines = k =>
      Array.isArray(b[k])
        ? b[k].map(x => clean(x, 500)).filter(Boolean).slice(0, 30)
        : [];

    const deliverables = lines("deliverables");

    if (
      !UUID.test(id) ||
      !scope ||
      !terms ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !Number.isFinite(until) ||
      until <= Date.now() ||
      !deliverables.length
    ) {
      return fail(s, 400, "Invalid quote fields.");
    }

    const z = await db.rpc("dapp_service_admin_issue_quote", {
      p_request_id: id,
      p_admin_user_id: a.user.id,
      p_quote: {
        currency_or_asset: "PI",
        scope_summary: scope,
        out_of_scope: lines("out_of_scope"),
        deliverables,
        total_amount: amount,
        valid_until: new Date(until).toISOString(),
        revisions_included:
          b.revisions_included == null
            ? null
            : Number(b.revisions_included),
        estimated_turnaround_days:
          b.estimated_turnaround_days == null
            ? null
            : Number(b.estimated_turnaround_days),
        terms_version: terms
      }
    });

    if (z.error) {
      return fail(s, statusOf(z.error), "Quote issuance failed.");
    }

    noStore(s);

    s.status(201).json({
      success: true,
      network: "mainnet",
      quote: z.data
    });
  });

  return r;
}

module.exports = {
  createDappServiceV2GatewayRouter,
  readConfig
};
