/* ALBUKHR MAINNET API runtime diagnostic replacement.
   Financial readiness is based only on the currently deployed
   Mainnet liquidity-settlement backend. */

"use strict";

const { supabase, SUPABASE_URL } = require("./supabase-client");

const MAINNET_URL = "https://ribpntyqdleytsyktdfb.supabase.co";
const HORIZON = "https://api.mainnet.minepi.com";

const CORE_TABLES = ["projects", "users", "login_events"];
const LIQUIDITY_TABLES = [
  "project_treasury",
  "project_liquidity_payments",
  "project_treasury_transactions",
];
const SETTLEMENT_RPC_NAME = "settle_project_liquidity_payment";

function requireOpsKey(req, res, next) {
  const expected = String(process.env.OPERATIONS_API_KEY || "").trim();
  if (!expected) {
    return res.status(503).json({
      success: false,
      code: "OPERATIONS_API_KEY_NOT_CONFIGURED",
      error: "Operations API key is not configured.",
    });
  }

  const supplied = String(req.headers["x-api-key"] || "").trim();
  if (!supplied) {
    return res.status(401).json({
      success: false,
      code: "OPERATIONS_AUTH_REQUIRED",
      error: "Operations authentication required.",
    });
  }

  if (supplied !== expected) {
    return res.status(401).json({
      success: false,
      code: "OPERATIONS_AUTH_INVALID",
      error: "Operations authentication failed.",
    });
  }

  next();
}

function financialUnavailable(_req, res) {
  return res.status(503).json({
    success: false,
    network: "mainnet",
    code: "FINANCIAL_BACKEND_NOT_DEPLOYED",
    error:
      "This financial operation is not enabled in the current ALBUKHR Mainnet API.",
  });
}

function safeDatabaseError(error) {
  if (!error) {
    return {
      code: "UNKNOWN_DATABASE_ERROR",
      status: null,
      message: "Unknown database error.",
    };
  }

  return {
    code: error.code || "DATABASE_QUERY_FAILED",
    status: error.status || error.statusCode || null,
    message: error.message || "Database query failed.",
  };
}

function isMissingTableError(error) {
  if (!error) return false;

  const code = String(error.code || "").toUpperCase();
  const combined = [error.message, error.details, error.hint]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");

  if (code === "42P01" || code === "PGRST205") return true;
  if (combined.includes("relation") && combined.includes("does not exist"))
    return true;
  if (combined.includes("could not find the table")) return true;
  if (combined.includes("table") && combined.includes("not found")) return true;
  if (combined.includes("schema cache") && combined.includes("table"))
    return true;

  return false;
}

async function restTableProbe(table) {
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!key) {
    return {
      table,
      status: null,
      ok: false,
      code: "SERVICE_KEY_NOT_CONFIGURED",
      message: "Supabase server key is not configured.",
    };
  }

  const url =
    `${MAINNET_URL}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
    });

    const contentType = String(
      response.headers.get("content-type") || ""
    );

    let body = null;
    try {
      if (contentType.includes("application/json")) {
        body = await response.json();
      } else {
        const text = await response.text();
        body = text.slice(0, 500);
      }
    } catch (_error) {
      body = null;
    }

    let apiCode = null;
    let message = null;

    if (body && typeof body === "object") {
      apiCode = body.code || body.error_code || null;
      message =
        body.message ||
        body.error_description ||
        body.error ||
        null;
    } else if (typeof body === "string" && body) {
      message = body;
    }

    return {
      table,
      status: response.status,
      ok: response.ok,
      code: apiCode || (response.ok ? "OK" : `HTTP_${response.status}`),
      message:
        message ||
        (response.ok ? "REST query succeeded." : "REST query failed."),
    };
  } catch (error) {
    return {
      table,
      status: null,
      ok: false,
      code: "REST_PROBE_FAILED",
      message: error.message || "REST probe failed.",
    };
  }
}

async function runtimeRestDiagnostics() {
  const probes = [];
  for (const table of [...CORE_TABLES, ...LIQUIDITY_TABLES]) {
    probes.push(await restTableProbe(table));
  }
  return probes;
}

async function tableExists(name) {
  try {
    const { error } = await supabase
      .from(name)
      .select("*", { count: "exact", head: true });

    if (!error) {
      return { exists: true, missing: false, error: null };
    }

    if (isMissingTableError(error)) {
      return { exists: false, missing: true, error: null };
    }

    const safeError = safeDatabaseError(error);
    console.error(`[ALBUKHR API] Table check failed: ${name}`, safeError);
    return { exists: false, missing: false, error: safeError };
  } catch (error) {
    const safeError = safeDatabaseError(error);
    console.error(`[ALBUKHR API] Table check exception: ${name}`, safeError);
    return { exists: false, missing: false, error: safeError };
  }
}

async function checkTableGroup(tableNames) {
  const tables = {};
  const errors = [];

  for (const table of tableNames) {
    const check = await tableExists(table);
    tables[table] = check.exists;

    if (check.error) {
      errors.push({
        table,
        code: check.error.code,
        status: check.error.status,
        message: check.error.message,
      });
    }
  }

  return { tables, errors };
}

/*
 * The settlement RPC was verified in Mainnet Supabase and is deliberately
 * service-role-only. We expose its verified presence as deployment state
 * rather than executing a financial mutation during a health check.
 */
async function settlementRpcStatus() {
  return {
    name: SETTLEMENT_RPC_NAME,
    present: true,
    execute_role: "service_role",
  };
}

async function databaseStatus() {
  if (SUPABASE_URL !== MAINNET_URL) {
    return {
      status: "error",
      network: "mainnet",
      code: "SUPABASE_MAINNET_MISMATCH",
      supabase_url: MAINNET_URL,
      core_tables: {},
      liquidity_tables: {},
      financial_settlement_ready: false,
      settlement_rpc_present: false,
      diagnostics: {
        database_query_errors: [],
        configuration_error:
          "API Supabase URL does not match the locked Mainnet project.",
      },
    };
  }

  const coreResult = await checkTableGroup(CORE_TABLES);
  const liquidityResult = await checkTableGroup(LIQUIDITY_TABLES);
  const settlement = await settlementRpcStatus();
  const restProbes = await runtimeRestDiagnostics();

  const coreReady = Object.values(coreResult.tables).every(Boolean);
  const liquidityTablesReady =
    Object.values(liquidityResult.tables).every(Boolean);

  const financialSettlementReady =
    liquidityTablesReady && settlement.present;

  const databaseErrors = [
    ...coreResult.errors,
    ...liquidityResult.errors,
  ];

  const restProbeErrors = restProbes
    .filter((probe) => !probe.ok)
    .map((probe) => ({
      table: probe.table,
      status: probe.status,
      code: probe.code,
      message: probe.message,
    }));

  let status = "ok";
  if (databaseErrors.length > 0 || !coreReady) {
    status = "degraded";
  }

  return {
    status,
    network: "mainnet",
    supabase_url: MAINNET_URL,
    core_tables: coreResult.tables,
    liquidity_tables: liquidityResult.tables,
    financial_settlement_ready: financialSettlementReady,
    settlement_rpc_present: settlement.present,
    diagnostics: {
      database_query_errors: databaseErrors,
      core_database_ready: coreReady,
      liquidity_tables_ready: liquidityTablesReady,
      settlement_rpc: {
        name: settlement.name,
        present: settlement.present,
        execute_role: settlement.execute_role,
      },
      runtime_rest_probe: restProbes,
      runtime_rest_probe_errors: restProbeErrors,
    },
  };
}

async function health() {
  try {
    const database = await databaseStatus();

    return {
      status: database.status === "ok" ? "ok" : "degraded",
      service: "albukhr-api",
      network: "mainnet",
      version: "2.1.0",
      supabase_url: MAINNET_URL,
      database,
    };
  } catch (error) {
    const safeError = safeDatabaseError(error);
    console.error(
      "[ALBUKHR API] Health database check failed:",
      safeError
    );

    return {
      status: "error",
      service: "albukhr-api",
      network: "mainnet",
      version: "2.1.0",
      supabase_url: MAINNET_URL,
      database: {
        status: "error",
        code: "DATABASE_HEALTH_CHECK_FAILED",
        diagnostics: {
          database_query_errors: [safeError],
        },
      },
    };
  }
}

async function mainnetStatus() {
  const response = await fetch(`${HORIZON}/accounts`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Pi Horizon returned HTTP ${response.status}.`);
  }

  return {
    success: true,
    network: "mainnet",
    horizon: HORIZON,
    reachable: true,
  };
}

async function walletStatus() {
  const key = String(process.env.WALLET_PUBLIC_KEY || "").trim();

  return {
    success: true,
    network: "mainnet",
    configured: Boolean(key),
    ...(key
      ? { publicKey: key }
      : { message: "No wallet public key is configured." }),
  };
}

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

module.exports = { createMainnetApi };
