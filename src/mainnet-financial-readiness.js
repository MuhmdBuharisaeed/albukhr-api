"use strict";

const READINESS_SCHEMA = "albukhr_security";
const READINESS_RPC = "get_mainnet_financial_readiness_v1";
const READINESS_CONTRACT = "mainnet_financial_readiness_v1";

function failedReadiness(code, message, present = false) {
  return {
    name: `${READINESS_SCHEMA}.${READINESS_RPC}`,
    present,
    ready: false,
    settlementRpcPresent: false,
    code,
    message,
    diagnostics: null,
  };
}

function normalizeReadinessProjection(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return failedReadiness("FINANCIAL_READINESS_INVALID_RESPONSE", "Readiness RPC returned an invalid response.");
  }

  if (
    data.contract_version !== READINESS_CONTRACT ||
    String(data.network || "").toLowerCase() !== "mainnet"
  ) {
    return failedReadiness("FINANCIAL_READINESS_CONTRACT_MISMATCH", "Readiness RPC returned an unexpected contract or network.");
  }

  const ready = data.ready === true;
  const settlementRpcPresent = data.functions?.liquidity_settlement_present === true;

  return {
    name: `${READINESS_SCHEMA}.${READINESS_RPC}`,
    present: true,
    ready,
    settlementRpcPresent,
    code: ready ? "OK" : "FINANCIAL_READINESS_NOT_READY",
    message: ready
      ? "Mainnet financial schema and trusted RPC readiness checks passed."
      : "One or more Mainnet financial schema, RPC, grant or RLS checks failed.",
    diagnostics: data,
  };
}

async function readMainnetFinancialReadiness(client) {
  if (!client || typeof client.schema !== "function") {
    return failedReadiness("FINANCIAL_READINESS_CLIENT_UNAVAILABLE", "Mainnet Supabase client is unavailable.");
  }

  try {
    const schemaClient = client.schema(READINESS_SCHEMA);
    if (!schemaClient || typeof schemaClient.rpc !== "function") {
      return failedReadiness("FINANCIAL_READINESS_SCHEMA_UNAVAILABLE", "Mainnet financial readiness schema is unavailable.");
    }

    const { data, error } = await schemaClient.rpc(READINESS_RPC);
    if (error) {
      return failedReadiness(
        error.code || "FINANCIAL_READINESS_RPC_FAILED",
        "Mainnet financial readiness RPC could not be read."
      );
    }

    return normalizeReadinessProjection(data);
  } catch (_error) {
    return failedReadiness("FINANCIAL_READINESS_RPC_EXCEPTION", "Mainnet financial readiness RPC failed unexpectedly.");
  }
}

module.exports = {
  normalizeReadinessProjection,
  readMainnetFinancialReadiness,
};
