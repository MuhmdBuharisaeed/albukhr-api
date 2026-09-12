"use strict";

const {
  supabase,
  SUPABASE_URL,
} = require("./supabase-client");

/* =========================================================
 * ALBUKHR MAINNET API
 * =========================================================
 *
 * Mainnet-only backend status and infrastructure layer.
 *
 * IMPORTANT:
 * - Supabase is the source of truth.
 * - This API is locked to ALBUKHR Mainnet.
 * - No Testnet Supabase is permitted.
 * - Financial operations remain fail-closed until the
 *   complete financial backend is verified.
 * - Missing financial tables are NOT treated as a
 *   database connection failure.
 * - Unexpected database errors are reported safely
 *   through diagnostics without exposing secrets.
 * ========================================================= */

const MAINNET_URL =
  "https://ribpntyqdleytsyktdfb.supabase.co";

const HORIZON =
  "https://api.mainnet.minepi.com";

/* =========================================================
 * EXPECTED CORE TABLES
 * ========================================================= */

const CORE_TABLES = [
  "projects",
  "users",
  "login_events",
];

/* =========================================================
 * EXPECTED FINANCIAL TABLES
 * ========================================================= */

const FINANCIAL_TABLES = [
  "stakes",
  "transactions",
  "withdraw_requests",
  "project_treasury",
  "project_treasury_transactions",
];

/* =========================================================
 * FINANCIAL SETTLEMENT RPC
 * =========================================================
 *
 * The current Mainnet architecture does not yet expose
 * the settlement RPC through this API.
 *
 * Keep this explicit.
 * Do NOT assume that the RPC exists merely because
 * financial tables exist.
 * ========================================================= */

const SETTLEMENT_RPC_NAME =
  "settle_project_liquidity_payment";

/* =========================================================
 * OPERATIONS API KEY
 * ========================================================= */

function requireOpsKey(req, res, next) {
  const key = String(
    process.env.OPERATIONS_API_KEY || ""
  ).trim();

  if (!key) {
    return res.status(503).json({
      success: false,
      code: "OPERATIONS_API_KEY_NOT_CONFIGURED",
      error:
        "Operations API key is not configured.",
    });
  }

  const suppliedKey = String(
    req.headers["x-api-key"] || ""
  ).trim();

  if (!suppliedKey) {
    return res.status(401).json({
      success: false,
      code: "OPERATIONS_AUTH_REQUIRED",
      error:
        "Operations authentication required.",
    });
  }

  if (suppliedKey !== key) {
    return res.status(401).json({
      success: false,
      code: "OPERATIONS_AUTH_INVALID",
      error:
        "Operations authentication failed.",
    });
  }

  next();
}

/* =========================================================
 * FINANCIAL ENDPOINT FAIL-CLOSED HANDLER
 * ========================================================= */

function financialUnavailable(_req, res) {
  return res.status(503).json({
    success: false,
    network: "mainnet",
    code: "FINANCIAL_BACKEND_NOT_DEPLOYED",
    error:
      "Mainnet financial settlement is disabled until the complete financial backend and settlement RPC are verified and deployed.",
  });
}

/* =========================================================
 * SAFE ERROR EXTRACTION
 * =========================================================
 *
 * Never return:
 * - service-role key
 * - Authorization headers
 * - request secrets
 * - environment variables
 * - raw credentials
 *
 * Only return safe database diagnostic fields.
 * ========================================================= */

function safeDatabaseError(error) {
  if (!error) {
    return {
      code: "UNKNOWN_DATABASE_ERROR",
      status: null,
      message: "Unknown database error.",
    };
  }

  return {
    code:
      error.code ||
      "DATABASE_QUERY_FAILED",

    status:
      error.status ||
      error.statusCode ||
      null,

    message:
      error.message ||
      "Database query failed.",
  };
}

/* =========================================================
 * MISSING TABLE DETECTION
 * =========================================================
 *
 * These errors mean:
 *
 * "The requested table/relation is not available."
 *
 * That is different from:
 *
 * - permission denied
 * - invalid credentials
 * - network failure
 * - database outage
 * - malformed query
 *
 * Missing financial tables are allowed during the
 * pre-financial-backend stage.
 * ========================================================= */

function isMissingTableError(error) {
  if (!error) {
    return false;
  }

  const code = String(
    error.code || ""
  ).toUpperCase();

  const message = String(
    error.message || ""
  ).toLowerCase();

  const details = String(
    error.details || ""
  ).toLowerCase();

  const hint = String(
    error.hint || ""
  ).toLowerCase();

  /* PostgreSQL undefined_table */
  if (code === "42P01") {
    return true;
  }

  /* PostgREST missing relation/schema cache */
  if (code === "PGRST205") {
    return true;
  }

  const combined =
    `${message} ${details} ${hint}`;

  if (
    combined.includes("relation") &&
    combined.includes("does not exist")
  ) {
    return true;
  }

  if (
    combined.includes("could not find the table") ||
    (
      combined.includes("table") &&
      combined.includes("not found")
    )
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

/* =========================================================
 * TABLE EXISTENCE CHECK
 * =========================================================
 *
 * Return:
 *
 * {
 *   exists: true
 * }
 *
 * OR
 *
 * {
 *   exists: false,
 *   missing: true
 * }
 *
 * OR
 *
 * {
 *   exists: false,
 *   error: {...}
 * }
 *
 * This lets databaseStatus() distinguish:
 *
 * missing table
 *
 * from
 *
 * real DB failure.
 * ========================================================= */

async function tableExists(name) {
  try {
    const {
      error,
    } = await supabase
      .from(name)
      .select("*", {
        count: "exact",
        head: true,
      });

    if (!error) {
      return {
        exists: true,
        missing: false,
        error: null,
      };
    }

    if (isMissingTableError(error)) {
      return {
        exists: false,
        missing: true,
        error: null,
      };
    }

    const safeError =
      safeDatabaseError(error);

    console.error(
      `[ALBUKHR API] Table check failed: ${name}`,
      safeError
    );

    return {
      exists: false,
      missing: false,
      error: safeError,
    };
  } catch (error) {
    const safeError =
      safeDatabaseError(error);

    console.error(
      `[ALBUKHR API] Table check exception: ${name}`,
      safeError
    );

    return {
      exists: false,
      missing: false,
      error: safeError,
    };
  }
}

/* =========================================================
 * CHECK TABLE GROUP
 * ========================================================= */

async function checkTableGroup(tableNames) {
  const result = {};
  const errors = [];

  for (const table of tableNames) {
    const check =
      await tableExists(table);

    result[table] = check.exists;

    if (check.error) {
      errors.push({
        table,
        code: check.error.code,
        status: check.error.status,
        message: check.error.message,
      });
    }
  }

  return {
    tables: result,
    errors,
  };
}

/* =========================================================
 * SETTLEMENT RPC STATUS
 * =========================================================
 *
 * IMPORTANT:
 *
 * We do NOT assume the RPC exists simply because
 * financial tables exist.
 *
 * The current API deliberately reports it as unavailable
 * until the RPC is actually verified in Mainnet.
 * ========================================================= */

async function settlementRpcStatus() {
  /*
   * The current Mainnet API does not call the settlement
   * RPC from the browser or pretend that it exists.
   *
   * Keep this false until the RPC is explicitly deployed
   * and verified.
   */

  return {
    name: SETTLEMENT_RPC_NAME,
    present: false,
  };
}

/* =========================================================
 * DATABASE STATUS
 * ========================================================= */

async function databaseStatus() {
  /* -------------------------------------------------------
   * MAINNET SAFETY CHECK
   * ----------------------------------------------------- */

  if (SUPABASE_URL !== MAINNET_URL) {
    return {
      status: "error",
      network: "mainnet",
      code: "SUPABASE_MAINNET_MISMATCH",
      supabase_url: MAINNET_URL,

      core_tables: {},
      financial_tables: {},

      financial_settlement_ready: false,

      settlement_rpc_present: false,

      diagnostics: {
        database_query_errors: [],
        configuration_error:
          "API Supabase URL does not match the locked Mainnet project.",
      },
    };
  }

  /* -------------------------------------------------------
   * CORE TABLES
   * ----------------------------------------------------- */

  const coreResult =
    await checkTableGroup(
      CORE_TABLES
    );

  /* -------------------------------------------------------
   * FINANCIAL TABLES
   * ----------------------------------------------------- */

  const financialResult =
    await checkTableGroup(
      FINANCIAL_TABLES
    );

  /* -------------------------------------------------------
   * SETTLEMENT RPC
   * ----------------------------------------------------- */

  const settlement =
    await settlementRpcStatus();

  /* -------------------------------------------------------
   * READINESS CALCULATIONS
   * ----------------------------------------------------- */

  const coreReady =
    Object.values(
      coreResult.tables
    ).every(Boolean);

  const financialTablesReady =
    Object.values(
      financialResult.tables
    ).every(Boolean);

  /*
   * Financial settlement is ONLY ready when:
   *
   * 1. all required financial tables exist
   * 2. settlement RPC exists
   *
   * Never mark it ready from tables alone.
   */

  const financialSettlementReady =
    financialTablesReady &&
    settlement.present;

  /* -------------------------------------------------------
   * ALL DATABASE ERRORS
   * ----------------------------------------------------- */

  const databaseErrors = [
    ...coreResult.errors,
    ...financialResult.errors,
  ];

  /* -------------------------------------------------------
   * DATABASE STATUS
   * ----------------------------------------------------- */

  let status = "ok";

  /*
   * A real database query/configuration error
   * is different from a missing table.
   */
  if (
    databaseErrors.length > 0
  ) {
    status = "degraded";
  }

  /*
   * Core tables are required for normal API
   * database readiness.
   */
  if (!coreReady) {
    status = "degraded";
  }

  return {
    status,

    network: "mainnet",

    supabase_url: MAINNET_URL,

    core_tables:
      coreResult.tables,

    financial_tables:
      financialResult.tables,

    financial_settlement_ready:
      financialSettlementReady,

    settlement_rpc_present:
      settlement.present,

    diagnostics: {
      database_query_errors:
        databaseErrors,

      core_database_ready:
        coreReady,

      financial_tables_ready:
        financialTablesReady,

      settlement_rpc: {
        name: settlement.name,
        present: settlement.present,
      },
    },
  };
}

/* =========================================================
 * HEALTH
 * ========================================================= */

async function health() {
  try {
    const database =
      await databaseStatus();

    return {
      status:
        database.status === "ok"
          ? "ok"
          : "degraded",

      service:
        "albukhr-api",

      network:
        "mainnet",

      version:
        "2.0.0",

      supabase_url:
        MAINNET_URL,

      database,
    };
  } catch (error) {
    const safeError =
      safeDatabaseError(error);

    console.error(
      "[ALBUKHR API] Health database check failed:",
      safeError
    );

    return {
      status: "error",

      service:
        "albukhr-api",

      network:
        "mainnet",

      version:
        "2.0.0",

      supabase_url:
        MAINNET_URL,

      database: {
        status: "error",

        code:
          "DATABASE_HEALTH_CHECK_FAILED",

        diagnostics: {
          database_query_errors: [
            safeError,
          ],
        },
      },
    };
  }
}

/* =========================================================
 * PI MAINNET HORIZON STATUS
 * ========================================================= */

async function mainnetStatus() {
  const response =
    await fetch(
      `${HORIZON}/accounts`,
      {
        method: "GET",

        headers: {
          Accept:
            "application/json",
        },
      }
    );

  if (!response.ok) {
    throw new Error(
      `Pi Horizon returned HTTP ${response.status}.`
    );
  }

  return {
    success: true,

    network:
      "mainnet",

    horizon:
      HORIZON,

    reachable:
      true,
  };
}

/* =========================================================
 * WALLET STATUS
 * =========================================================
 *
 * Only public wallet configuration is exposed.
 *
 * NEVER expose:
 * WALLET_PRIVATE_SEED
 * ========================================================= */

async function walletStatus() {
  const key =
    String(
      process.env.WALLET_PUBLIC_KEY || ""
    ).trim();

  return {
    success: true,

    network:
      "mainnet",

    configured:
      Boolean(key),

    ...(key
      ? {
          publicKey: key,
        }
      : {
          message:
            "No wallet public key is configured.",
        }),
  };
}

/* =========================================================
 * CREATE MAINNET API
 * ========================================================= */

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

/* =========================================================
 * EXPORT
 * ========================================================= */

module.exports = {
  createMainnetApi,
};
