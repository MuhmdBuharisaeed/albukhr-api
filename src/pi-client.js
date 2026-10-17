"use strict";

/*
 * ALBUKHR Mainnet A2U client — REVIEW PATCH ONLY.
 *
 * Pi's official Advanced Payments documentation currently states that A2U is
 * Testnet-only. Keep the code-level gate false until Pi officially documents
 * Mainnet availability and ALBUKHR separately reviews the launch checklist.
 * Environment variables alone cannot override this source-level gate.
 */
const MAINNET_A2U_OFFICIALLY_SUPPORTED = false;
let PiNetworkConstructorPromise = null;

function envBoolean(name, defaultValue = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw);
}

function a2uEnabled() {
  return MAINNET_A2U_OFFICIALLY_SUPPORTED &&
    envBoolean("PI_A2U_ENABLED", false) &&
    envBoolean("PI_A2U_MAINNET_APPROVED", false) &&
    String(process.env.PI_A2U_NETWORK || "mainnet").trim().toLowerCase() === "mainnet";
}

function requireA2UEnabled() {
  if (!a2uEnabled()) {
    const error = new Error(
      "Pi A2U Mainnet payouts are disabled pending official Pi support and ALBUKHR approval."
    );
    error.code = "A2U_MAINNET_DISABLED";
    error.status = 503;
    throw error;
  }
}

function requireMainnetPiSdkEnvironment() {
  // The official Pi Node.js SDK reads PI_ENV, not NODE_ENV, and resolves its
  // package .env.production file from that value. This ALBUKHR API is Mainnet-only.
  const configured = String(process.env.PI_ENV || "production").trim().toLowerCase();
  if (configured !== "production") {
    const error = new Error("The Mainnet A2U client requires PI_ENV=production.");
    error.code = "PI_SDK_ENV_NOT_MAINNET";
    error.status = 503;
    throw error;
  }
  process.env.PI_ENV = "production";
}

function requirePiApiKey() {
  const key = String(process.env.PI_API_KEY || "").trim();
  if (!key) throw new Error("PI_API_KEY is not configured.");
  return key;
}

function requireWalletPrivateSeed() {
  const seed = String(process.env.WALLET_PRIVATE_SEED || "").trim();
  // Stellar secret seeds are 56 base-32 characters and start with S.
  if (!/^S[A-Z2-7]{55}$/.test(seed)) {
    throw new Error("WALLET_PRIVATE_SEED is missing or has an invalid format.");
  }
  return seed;
}

async function getPiClient() {
  requireA2UEnabled();
  requireMainnetPiSdkEnvironment();
  const apiKey = requirePiApiKey();
  const privateSeed = requireWalletPrivateSeed();

  // Cache only the SDK constructor, never the stateful SDK client. The official
  // SDK caches one currentPayment; a fresh instance for each operation forces
  // submitPayment() to reload the payment and current recipient from Pi rather
  // than reusing a stale in-memory DTO after a retry or wallet update.
  if (!PiNetworkConstructorPromise) {
    PiNetworkConstructorPromise = import("pi-backend")
      .then(({ default: PiNetwork }) => {
        if (typeof PiNetwork !== "function") {
          throw new Error("Official pi-backend SDK did not expose its default constructor.");
        }
        return PiNetwork;
      })
      .catch((error) => {
        // Permit a later retry if the module import failed.
        PiNetworkConstructorPromise = null;
        throw error;
      });
  }

  const PiNetwork = await PiNetworkConstructorPromise;
  return new PiNetwork(apiKey, privateSeed);
}

function positiveAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1_000_000_000) {
    throw new Error("A2U amount is invalid.");
  }
  return number;
}

function requiredText(value, field, max = 250) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw new Error(`${field} is invalid.`);
  return text;
}

async function createA2UPayment({ uid, amount, memo, metadata = {} }) {
  const pi = await getPiClient();
  const paymentId = await pi.createPayment({
    amount: positiveAmount(amount),
    memo: requiredText(memo, "memo"),
    metadata,
    uid: requiredText(uid, "uid", 200)
  });
  return { payment_id: requiredText(paymentId, "payment identifier", 200) };
}

async function getA2UPayment(paymentId) {
  const pi = await getPiClient();
  return pi.getPayment(requiredText(paymentId, "payment_id", 200));
}

async function getIncompleteA2UPayments() {
  const pi = await getPiClient();
  const result = await pi.getIncompleteServerPayments();
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.incomplete_server_payments)) {
    return result.incomplete_server_payments;
  }
  return [];
}

async function submitA2UPayment(paymentId) {
  const pi = await getPiClient();
  return requiredText(
    await pi.submitPayment(requiredText(paymentId, "payment_id", 200)),
    "Pi transaction id",
    300
  );
}

async function completeA2UPayment(paymentId, txid) {
  const pi = await getPiClient();
  return pi.completePayment(
    requiredText(paymentId, "payment_id", 200),
    requiredText(txid, "txid", 300)
  );
}

async function cancelA2UPayment(paymentId) {
  const pi = await getPiClient();
  return pi.cancelPayment(requiredText(paymentId, "payment_id", 200));
}

function walletStatus() {
  return {
    a2u_enabled: a2uEnabled(),
    mainnet_a2u_officially_supported_in_this_release: MAINNET_A2U_OFFICIALLY_SUPPORTED,
    pi_a2u_enabled_flag: envBoolean("PI_A2U_ENABLED", false),
    pi_a2u_mainnet_approved_flag: envBoolean("PI_A2U_MAINNET_APPROVED", false),
    pi_api_key_configured: Boolean(String(process.env.PI_API_KEY || "").trim()),
    wallet_seed_configured: Boolean(String(process.env.WALLET_PRIVATE_SEED || "").trim())
  };
}

module.exports = {
  a2uEnabled,
  requireMainnetPiSdkEnvironment,
  walletStatus,
  createA2UPayment,
  getA2UPayment,
  getIncompleteA2UPayments,
  submitA2UPayment,
  completeA2UPayment,
  cancelA2UPayment
};
