"use strict";

const { supabase, SUPABASE_URL } = require("./supabase-client");

const MAINNET_URL = "https://ribpntyqdleytsyktdfb.supabase.co";
const HORIZON = "https://api.mainnet.minepi.com";

/*
 * ALBUKHR MAINNET API
 *
 * Purpose:
 * - Mainnet-only
 * - Read-only infrastructure/status layer
 * - Financial backend remains disabled until the required
 *   Mainnet financial schema and settlement RPC are deployed.
 */

function requireOpsKey(req, res, next) {
  const key = String(process.env.OPERATIONS_API_KEY || "").trim();

  if (!key) {
    return res.status(503).json({
      success: false,
      error: "Operations API key is not configured.",
    });
  }

  if (String(req.headers["x-api-key"] || "") !== key) {
    return res.status(401).json({
      success: false,
      error: "Operations authentication required.",
    });
  }

  next();
}

/*
 * Financial operations are intentionally disabled.
 *
 * This is NOT an error.
 * It means the Mainnet financial backend has not yet been deployed.
 */
function financialUnavailable(_req, res) {
  return res.status(503).json({
    success: false,
    network: "mainnet",
    code: "FINANCIAL_BACKEND_NOT_DEPLOYED",
    error:
      "Mainnet financial settlement is disabled because the current Mainnet Supabase database does not contain the required treasury, staking, withdrawal, transaction, or settlement RPC objects.",
  });
}

/*
 * Detect whether a Supabase/PostgREST error means:
 *
 * "This table does not exist."
 *
 * Missing tables are expected for the current financial backend.
 * They must return false instead of throwing an exception.
 */
function isMissingTableError(error) {
  if (!error) {
    return false;
  }

  const code = String(error.code || "").toUpperCase();
  const message = String(error.message || "").toLowerCase();
  const details = String(error.details || "").toLowerCase();
  const hint = String(error.hint || "").toLowerCase();

  /*
   * PostgreSQL undefined_table.
   */
  if (code === "42P01") {
    return true;
  }

  /*
   * PostgREST schema-cache missing relation.
   */
  if (code === "PGRST205") {
    return true;
  }

  /*
   * Some responses may not expose the expected code,
   * so use conservative message matching as a fallback.
   */
  const combined = `${message} ${details} ${hint}`;

  if (
    combined.includes("relation") &&
    combined.includes("does not exist")
  ) {
    return true;
  }

  if (
    combined.includes("could not find the table") ||
    combined.includes("table") &&
      combined.includes("not found")
  ) {
    return true;
  }

  if (
    combined.includes("schema cache") &&
    combined.includes("table")
  ) {
    return true;
  }

  return false;
}

/*
 * Check whether a table exists.
 *
 * IMPORTANT:
 * - Existing table      -> true
 * - Missing table       -> false
 * - Permission/network/
 *   unexpected DB error -> throw
 *
 * This distinction is critical.
 */
async function tableExists(name) {
  const { error } = await supabase
    .from(name)
    .select("*", {
      count: "exact",
      head: true,
    });

  if (!error) {
    return true;
  }

  if (isMissingTableError(error)) {
    return false;
  }

  /*
   * Do NOT hide unexpected database errors.
   * They indicate a real infrastructure/configuration problem.
   */
  throw error;
}

/*
 * Check the Mainnet database.
 */
async function databaseStatus() {
  const core = {};
  const financial = {};

  /*
   * Core ALBUKHR tables.
   */
  for (const table of [
    "projects",
    "users",
    "login_events",
  ]) {
    core[table] = await tableExists(table);
  }

  /*
   * Financial tables.
   *
   * Missing financial tables are valid at the current
   * architecture stage and will simply be reported false.
   */
  for (const table of [
    "stakes",
    "transactions",
    "withdraw_requests",
    "project_treasury",
    "project_treasury_transactions",
  ]) {
    financial[table] = await tableExists(table);
  }

  const coreReady = Object.values(core).every(Boolean);

  const financialReady = Object.values(financial).every(Boolean);

  return {
    status: coreReady ? "ok" : "degraded",

    network: "mainnet",

    supabase_url: MAINNET_URL,

    core_tables: core,

    financial_tables: financial,

    financial_settlement_ready: financialReady,

    /*
     * The RPC is not deployed in the current Mainnet DB.
     * Keep this explicit instead of pretending settlement exists.
     */
    settlement_rpc_present: false,
  };
}

/*
 * Public health status.
 */
async function health() {
  const database = await databaseStatus();

  return {
    status: database.status === "ok" ? "ok" : "degraded",

    service: "albukhr-api",

    network: "mainnet",

    supabase_url: MAINNET_URL,

    database,
  };
}

/*
 * Pi Mainnet Horizon status.
 */
async function mainnetStatus() {
  const response = await fetch(`${HORIZON}/accounts`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Pi Horizon returned HTTP ${response.status}.`
    );
  }

  return {
    success: true,

    network: "mainnet",

    horizon: HORIZON,

    reachable: true,
  };
}

/*
 * Wallet status.
 *
 * Only the PUBLIC key is exposed.
 * Never expose WALLET_PRIVATE_SEED.
 */
async function walletStatus() {
  const key = String(
    process.env.WALLET_PUBLIC_KEY || ""
  ).trim();

  return {
    success: true,

    network: "mainnet",

    configured: Boolean(key),

    ...(key
      ? {
          publicKey: key,
        }
      : {
          message: "No wallet public key is configured.",
        }),
  };
}

/*
 * Factory
 */
function createMainnetApi() {
  return {
    requireOpsKey,

    financialUnavailable,

    databaseStatus,

    health,

    mainnetStatus,

    walletStatus,
  };
}

module.exports = {
  createMainnetApi,
};
