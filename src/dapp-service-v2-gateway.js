"use strict";

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const NETWORK_URLS = Object.freeze({
  mainnet: "https://ribpntyqdleytsyktdfb.supabase.co",
  testnet: "https://vhvkwvngmrlgyzwemttt.supabase.co"
});
const SERVICE_TYPES = Object.freeze([
  { id: "pi_studio", title: "Pi Studio Assistance", quoteRequired: true },
  { id: "developer", title: "Developer-built dApp", quoteRequired: true }
]);

function readConfig(env = process.env) {
  const network = String(env.DAPP_SERVICE_NETWORK || "").trim().toLowerCase();
  const url = String(env.DAPP_SERVICE_SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const key = String(env.DAPP_SERVICE_SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const piApiBase = String(env.DAPP_SERVICE_PI_API_BASE || "").trim().replace(/\/+$/, "");
  if (!Object.prototype.hasOwnProperty.call(NETWORK_URLS, network)) {
    throw new Error("DAPP_SERVICE_NETWORK must be mainnet or testnet.");
  }
  if (url !== NETWORK_URLS[network]) {
    throw new Error("DAPP_SERVICE_SUPABASE_URL does not match DAPP_SERVICE_NETWORK.");
  }
  if (!key) throw new Error("DAPP_SERVICE_SUPABASE_SERVICE_ROLE_KEY is required.");
  if (!piApiBase) throw new Error("DAPP_SERVICE_PI_API_BASE must be verified and configured for this network.");
  if (network === "mainnet" && piApiBase !== "https://api.minepi.com/v2") {
    throw new Error("Mainnet Pi API base does not match the approved endpoint.");
  }
  return { network, url, key, piApiBase };
}

function bearerToken(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}
function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/\u0000/g, "").trim().slice(0, max) : "";
}
function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function createDappServiceV2GatewayRouter(options = {}) {
  const config = options.config || readConfig();
  const supabase = options.supabase || createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "X-ALBUKHR-Feature": "dapp-service-v2" } }
  });
  const router = express.Router();

  async function verifiedPioneer(req, res) {
    const token = bearerToken(req);
    if (!token) { fail(res, 401, "Pi authentication is required."); return null; }
    try {
      const response = await fetch(config.piApiBase + "/me", {
        headers: { Authorization: "Bearer " + token, Accept: "application/json" }
      });
      const pioneer = await response.json().catch(() => null);
      if (!response.ok || !pioneer || typeof pioneer.uid !== "string" || !pioneer.uid.trim()) {
        fail(res, 401, "Pi identity could not be verified."); return null;
      }
      return pioneer;
    } catch (_) {
      fail(res, 401, "Pi identity could not be verified."); return null;
    }
  }

  router.get("/catalog", (_req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json({
      success: true, network: config.network, quoteRequired: true,
      paymentChannels: { pi: false, bankTransfer: false }, services: SERVICE_TYPES
    });
  });

  router.post("/requests", async (req, res) => {
    const pioneer = await verifiedPioneer(req, res);
    if (!pioneer) return;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const projectName = cleanText(body.projectName, 120);
    const description = cleanText(body.description, 4000);
    const serviceType = cleanText(body.serviceType, 40);
    const consentVersion = cleanText(body.consentVersion, 80);
    const accepted = body.consentAccepted === true;
    const requiredVersion = cleanText(process.env.DAPP_SERVICE_CONSENT_VERSION, 80);

    if (!requiredVersion) return fail(res, 503, "Service terms are not configured; requests are temporarily unavailable.");
    if (!accepted || consentVersion !== requiredVersion) return fail(res, 400, "Please accept the current service terms.");
    if (!projectName || !description || !SERVICE_TYPES.some(x => x.id === serviceType)) {
      return fail(res, 400, "Project name, description, and a valid service type are required.");
    }

    const row = {
      network: config.network, applicant_pi_uid: pioneer.uid.trim(),
      pi_username: cleanText(pioneer.username, 100) || null,
      project_name: projectName, service_type: serviceType, description,
      consent_version: requiredVersion, request_status: "submitted", payment_status: "unpaid"
    };
    try {
      const { data, error } = await supabase.from("dapp_service_requests")
        .insert(row)
        .select("id, network, project_name, service_type, request_status, payment_status, created_at")
        .single();
      if (error) {
        console.error("[DAPP_SERVICE_V2] insert failed:", error.code || error.message);
        return fail(res, 503, "The request could not be saved. Please try again later.");
      }
      res.set("Cache-Control", "no-store");
      return res.status(201).json({ success: true, request: data });
    } catch (error) {
      console.error("[DAPP_SERVICE_V2] unexpected insert error:", error && error.message);
      return fail(res, 503, "The request could not be saved. Please try again later.");
    }
  });

  router.get("/requests", async (req, res) => {
    const pioneer = await verifiedPioneer(req, res);
    if (!pioneer) return;
    try {
      const { data, error } = await supabase.from("dapp_service_requests")
        .select("id, network, project_name, service_type, request_status, payment_status, created_at, updated_at")
        .eq("network", config.network).eq("applicant_pi_uid", pioneer.uid.trim())
        .order("created_at", { ascending: false }).limit(50);
      if (error) {
        console.error("[DAPP_SERVICE_V2] history query failed:", error.code || error.message);
        return fail(res, 503, "Request history is temporarily unavailable.");
      }
      res.set("Cache-Control", "no-store");
      return res.json({ success: true, network: config.network, requests: data || [] });
    } catch (error) {
      console.error("[DAPP_SERVICE_V2] unexpected history error:", error && error.message);
      return fail(res, 503, "Request history is temporarily unavailable.");
    }
  });

  return router;
}

module.exports = { createDappServiceV2GatewayRouter, readConfig };
