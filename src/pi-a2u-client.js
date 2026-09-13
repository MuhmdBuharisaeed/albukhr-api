"use strict";

const StellarSdk = require("stellar-sdk");

const PI_API_BASE = "https://api.minepi.com/v2";
const PI_HORIZON_URL = "https://api.mainnet.minepi.com";
const PI_NETWORK_PASSPHRASE = "Pi Network";

function a2uEnabled() {
  return String(process.env.PI_A2U_ENABLED || "false").trim().toLowerCase() === "true";
}

function requirePiApiKey() {
  const key = String(process.env.PI_API_KEY || "").trim();
  if (!key) throw new Error("PI_API_KEY is not configured.");
  return key;
}

function requireWalletPrivateSeed() {
  const seed = String(process.env.WALLET_PRIVATE_SEED || "").trim();
  if (!seed) throw new Error("WALLET_PRIVATE_SEED is not configured.");
  if (!/^S[A-Z0-9]{55}$/i.test(seed)) throw new Error("WALLET_PRIVATE_SEED is invalid.");
  return seed;
}

function requireA2UEnabled() {
  if (!a2uEnabled()) {
    const error = new Error("Pi A2U payout execution is disabled.");
    error.code = "A2U_MAINNET_DISABLED";
    error.status = 503;
    throw error;
  }
}

function amount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error("A2U amount is invalid.");
  return n;
}

function text(value, field, max = 250) {
  const v = String(value || "").trim();
  if (!v || v.length > max) throw new Error(`${field} is invalid.`);
  return v;
}

async function piRequest(path, options = {}) {
  const response = await fetch(`${PI_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Key ${requirePiApiKey()}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw || null; }

  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Pi API request failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function createA2UPayment({ uid, amount: value, memo, metadata = {} }) {
  requireA2UEnabled();
  const payment = await piRequest("/payments", {
    method: "POST",
    body: JSON.stringify({
      amount: amount(value),
      memo: text(memo, "memo"),
      metadata,
      uid: text(uid, "uid", 200)
    })
  });
  const paymentId = text(payment?.identifier, "payment identifier", 200);
  const recipient = text(
    payment?.recipient || payment?.to_address || payment?.recipient_address,
    "payment recipient",
    200
  );
  return { payment, payment_id: paymentId, recipient };
}

async function loadWalletAccount() {
  requireA2UEnabled();
  const keypair = StellarSdk.Keypair.fromSecret(requireWalletPrivateSeed());
  const server = new StellarSdk.Server(PI_HORIZON_URL);
  const account = await server.loadAccount(keypair.publicKey());
  const baseFee = await server.fetchBaseFee();
  return { server, keypair, publicKey: keypair.publicKey(), account, baseFee };
}

async function submitA2UPayment(paymentId, recipient, value) {
  requireA2UEnabled();
  const id = text(paymentId, "payment_id", 200);
  const destination = text(recipient, "recipient", 200);
  const paymentAmount = amount(value);

  if (!StellarSdk.StrKey.isValidEd25519PublicKey(destination)) {
    throw new Error("Pi payout recipient address is invalid.");
  }

  const wallet = await loadWalletAccount();
  const operation = StellarSdk.Operation.payment({
    destination,
    asset: StellarSdk.Asset.native(),
    amount: paymentAmount.toString()
  });
  const timebounds = await wallet.server.fetchTimebounds(180);

  const transaction = new StellarSdk.TransactionBuilder(wallet.account, {
    fee: String(wallet.baseFee),
    networkPassphrase: PI_NETWORK_PASSPHRASE,
    timebounds
  })
    .addOperation(operation)
    .addMemo(StellarSdk.Memo.text(id))
    .build();

  transaction.sign(wallet.keypair);
  const result = await wallet.server.submitTransaction(transaction);
  return {
    txid: text(result?.id, "transaction id", 300),
    public_key: wallet.publicKey,
    transaction: result
  };
}

async function getA2UPayment(paymentId) {
  requireA2UEnabled();
  return piRequest(`/payments/${encodeURIComponent(text(paymentId, "payment_id", 200))}`);
}

async function getIncompleteA2UPayments() {
  requireA2UEnabled();
  const result = await piRequest("/payments/incomplete_server_payments");
  return Array.isArray(result?.incomplete_server_payments) ? result.incomplete_server_payments : [];
}

async function completeA2UPayment(paymentId, txid) {
  requireA2UEnabled();
  return piRequest(`/payments/${encodeURIComponent(text(paymentId, "payment_id", 200))}/complete`, {
    method: "POST",
    body: JSON.stringify({ txid: text(txid, "txid", 300) })
  });
}

async function cancelA2UPayment(paymentId) {
  requireA2UEnabled();
  return piRequest(`/payments/${encodeURIComponent(text(paymentId, "payment_id", 200))}/cancel`, {
    method: "POST",
    body: "{}"
  });
}

function walletStatus() {
  return {
    a2u_enabled: a2uEnabled(),
    wallet_seed_configured: Boolean(String(process.env.WALLET_PRIVATE_SEED || "").trim())
  };
}

module.exports = {
  a2uEnabled,
  walletStatus,
  createA2UPayment,
  getA2UPayment,
  getIncompleteA2UPayments,
  submitA2UPayment,
  completeA2UPayment,
  cancelA2UPayment
};
