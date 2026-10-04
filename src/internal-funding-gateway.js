/* ALBUKHR — Contributor Internal Funding Gateway v1
 * Mainnet-only. Collects project funding plans and itemized costs.
 * Financial approval remains server/admin-controlled; this gateway never
 * accepts a contributor-declared liquidity amount as approved liquidity.
 *
 * Funding model:
 * - Contributor supplies project facts and itemized funding requirements.
 * - Contributor-declared liquidity/capital is input context only.
 * - Supabase calculates the authoritative incremental capital requirement.
 * - Liquidity is assessed and approved through the server/admin workflow.
 */
"use strict";

const express = require("express");
const { supabase } = require("./supabase-client");
const { getPioneer } = require("./pi-client");

const router = express.Router();

const MAINNET = "mainnet";
const INTERNAL_PROJECT_TYPE = "internal";
const CONTRIBUTOR_INTERNAL_SOURCE = "contributor_internal";

const ALLOWED_FUNDING_MODES = new Set([
  "startup",
  "expansion",
  "working_capital",
  "replacement",
  "mixed"
]);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function body(req) {
  return req.body &&
    typeof req.body === "object" &&
    !Array.isArray(req.body)
    ? req.body
    : {};
}

function clean(value, field, max = 200) {
  const text = String(value ?? "").trim();

  if (!text || text.length > max) {
    throw httpError(400, `${field} is invalid.`);
  }

  return text;
}

function optionalText(value, max = 1000) {
  const text = String(value ?? "").trim();

  if (!text) {
    return null;
  }

  if (text.length > max) {
    throw httpError(400, "Text field is too long.");
  }

  return text;
}

function optionalNumber(
  value,
  field,
  {
    min = 0,
    max = 1_000_000_000
  } = {}
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  if (
    !Number.isFinite(number) ||
    number < min ||
    number > max
  ) {
    throw httpError(
      400,
      `${field} is invalid.`
    );
  }

  return number;
}

function optionalInteger(
  value,
  field,
  {
    min = 1,
    max = 3650
  } = {}
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  if (
    !Number.isInteger(number) ||
    number < min ||
    number > max
  ) {
    throw httpError(
      400,
      `${field} is invalid.`
    );
  }

  return number;
}

function optionalDate(value, field) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw httpError(
      400,
      `${field} is invalid.`
    );
  }

  return date.toISOString();
}

function normalizeItems(value) {
  /*
   * Keep API validation aligned with the database function:
   * maximum 100 funding items.
   */
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 100
  ) {
    throw httpError(
      400,
      "items must contain between 1 and 100 cost lines."
    );
  }

  return value.map((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item)
    ) {
      throw httpError(
        400,
        `items[${index}] is invalid.`
      );
    }

    const category = clean(
      item.category,
      `items[${index}].category`,
      100
    );

    const description = clean(
      item.description,
      `items[${index}].description`,
      500
    );

    const quantity = Number(
      item.quantity
    );

    const unitCost = Number(
      item.unit_cost
    );

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      quantity > 1_000_000_000
    ) {
      throw httpError(
        400,
        `items[${index}].quantity is invalid.`
      );
    }

    if (
      !Number.isFinite(unitCost) ||
      unitCost < 0 ||
      unitCost > 1_000_000_000
    ) {
      throw httpError(
        400,
        `items[${index}].unit_cost is invalid.`
      );
    }

    return {
      category,
      description,
      quantity,
      unit: clean(
        item.unit || "unit",
        `items[${index}].unit`,
        50
      ),
      unit_cost: unitCost,
      deployment_stage: optionalText(
        item.deployment_stage,
        100
      ),
      notes: optionalText(
        item.notes,
        1000
      )
    };
  });
}

function requireBearer(req) {
  const header = String(
    req.headers.authorization || ""
  ).trim();

  if (
    !header
      .toLowerCase()
      .startsWith("bearer ")
  ) {
    throw httpError(
      401,
      "Pi authentication token is required."
    );
  }

  const token = header
    .slice(7)
    .trim();

  if (!token) {
    throw httpError(
      401,
      "Pi authentication token is required."
    );
  }

  return token;
}

async function verifiedPiIdentity(req) {
  const pioneer = await getPioneer(
    requireBearer(req)
  );

  const piUid = String(
    pioneer?.uid || ""
  ).trim();

  if (!piUid) {
    throw httpError(
      401,
      "Pi identity could not be verified."
    );
  }

  return {
    pi_uid: piUid
  };
}

async function getContributorInternalProject(
  projectCode
) {
  const code = clean(
    projectCode,
    "project_code",
    100
  );

  const {
    data,
    error
  } = await supabase
    .from("projects")
    .select(
      "id,project_code,project_type,status,network,registration_source,owner_albukhr_user_id"
    )
    .eq("project_code", code)
    .eq("network", MAINNET)
    .maybeSingle();

  if (error) {
    throw httpError(
      502,
      "ALBUKHR project lookup failed."
    );
  }

  if (!data) {
    throw httpError(
      404,
      "Mainnet project was not found."
    );
  }

  if (
    String(data.project_type || "")
      .toLowerCase() !==
      INTERNAL_PROJECT_TYPE ||
    String(data.registration_source || "")
      .toLowerCase() !==
      CONTRIBUTOR_INTERNAL_SOURCE
  ) {
    throw httpError(
      403,
      "This route is only for Contributor Internal Projects."
    );
  }

  if (
    String(data.network || "")
      .toLowerCase() !== MAINNET
  ) {
    throw httpError(
      403,
      "Only Mainnet Internal Projects are accepted."
    );
  }

  const status = String(
    data.status || ""
  ).toLowerCase();

  if (
    !["approved", "active"].includes(
      status
    )
  ) {
    throw httpError(
      403,
      "Internal Project is not eligible for funding-plan processing."
    );
  }

  if (!data.owner_albukhr_user_id) {
    throw httpError(
      409,
      "Internal Project Contributor owner is not configured."
    );
  }

  return data;
}

async function assertContributorOwner(
  project,
  piUid
) {
  const {
    data,
    error
  } = await supabase
    .from("users")
    .select(
      "id,pi_uid,network"
    )
    .eq(
      "id",
      project.owner_albukhr_user_id
    )
    .eq(
      "network",
      MAINNET
    )
    .maybeSingle();

  if (error) {
    throw httpError(
      502,
      "Contributor owner lookup failed."
    );
  }

  if (
    !data ||
    String(data.pi_uid || "") !==
      String(piUid || "") ||
    String(data.network || "")
      .toLowerCase() !== MAINNET
  ) {
    throw httpError(
      403,
      "Only the Contributor owner can manage this funding plan."
    );
  }

  return data;
}

/**
 * Convert a business-level RPC response failure into
 * an HTTP error instead of incorrectly returning HTTP 200.
 *
 * The funding RPCs intentionally return JSON such as:
 *
 *   { success: false, message: "..." }
 *
 * when a business rule rejects the operation.
 *
 * That is not a transport failure, so Supabase does not populate
 * `error`. The gateway must still expose it as an API failure.
 */
function rpcBusinessError(data, fallbackMessage) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    data.success !== false
  ) {
    return null;
  }

  const message = String(
    data.message ||
    fallbackMessage
  ).trim();

  const normalized = message.toLowerCase();

  let status = 409;

  if (
    normalized.includes("invalid") ||
    normalized.includes("must contain") ||
    normalized.includes("cannot be") ||
    normalized.includes("requires") ||
    normalized.includes("required")
  ) {
    status = 400;
  } else if (
    normalized.includes("authorization") ||
    normalized.includes("only the contributor")
  ) {
    status = 403;
  } else if (
    normalized.includes("identity was not found")
  ) {
    status = 401;
  }

  return httpError(
    status,
    message
  );
}

async function callGatewayRpc(
  functionName,
  args,
  errorMessage
) {
  const {
    data,
    error
  } = await supabase
    .schema("albukhr_security")
    .rpc(
      functionName,
      args
    );

  if (error) {
    console.error(
      `[ALBUKHR API] ${functionName} failed`,
      {
        code: error.code,
        message: error.message
      }
    );

    throw httpError(
      502,
      errorMessage
    );
  }

  const businessError =
    rpcBusinessError(
      data,
      errorMessage
    );

  if (businessError) {
    throw businessError;
  }

  return data;
}

function fundingPayload(b) {
  const fundingWindowStart =
    optionalDate(
      b.funding_window_start,
      "funding_window_start"
    );

  const fundingWindowEnd =
    optionalDate(
      b.funding_window_end,
      "funding_window_end"
    );

  /*
   * Match the database rule exactly:
   * end must be strictly after start.
   */
  if (
    fundingWindowStart &&
    fundingWindowEnd &&
    new Date(fundingWindowEnd) <=
      new Date(fundingWindowStart)
  ) {
    throw httpError(
      400,
      "funding_window_end must be later than funding_window_start."
    );
  }

  const fundingMode = clean(
    b.funding_mode,
    "funding_mode",
    50
  ).toLowerCase();

  if (
    !ALLOWED_FUNDING_MODES.has(
      fundingMode
    )
  ) {
    throw httpError(
      400,
      "funding_mode is invalid."
    );
  }

  return {
    businessStage: clean(
      b.business_stage,
      "business_stage",
      50
    ),

    fundingPurpose: clean(
      b.funding_purpose,
      "funding_purpose",
      100
    ),

    fundingMode,

    existingAssetBase:
      optionalNumber(
        b.existing_asset_base,
        "existing_asset_base"
      ),

    /*
     * This is deliberately treated as DECLARED liquidity.
     *
     * The database gateway function stores it as:
     *   declared_existing_liquidity
     *
     * and forces:
     *   existing_verified_liquidity = 0
     *
     * until an authoritative verification layer exists.
     */
    declaredExistingLiquidity:
      optionalNumber(
        b.existing_verified_liquidity ??
          b.declared_existing_liquidity,
        "existing_verified_liquidity"
      ),

    /*
     * Contributor may provide an expected capital figure,
     * but the database calculates the authoritative value
     * from itemized costs plus reserves.
     */
    declaredIncrementalCapital:
      optionalNumber(
        b.incremental_capital_requirement,
        "incremental_capital_requirement"
      ),

    fundingWindowStart,

    fundingWindowEnd,

    operatingCycleDays:
      optionalInteger(
        b.operating_cycle_days,
        "operating_cycle_days"
      ),

    expectedCapitalCycleDays:
      optionalInteger(
        b.expected_capital_cycle_days,
        "expected_capital_cycle_days"
      ),

    requiredReserve:
      optionalNumber(
        b.required_reserve,
        "required_reserve"
      ),

    contingencyReserve:
      optionalNumber(
        b.contingency_reserve,
        "contingency_reserve"
      ),

    notes:
      optionalText(
        b.notes,
        5000
      ),

    items:
      normalizeItems(
        b.items
      )
  };
}

router.get(
  "/api/contributor/project/funding-plan",
  async (req, res) => {
    try {
      const identity =
        await verifiedPiIdentity(
          req
        );

      const project =
        await getContributorInternalProject(
          req.query.project_code
        );

      await assertContributorOwner(
        project,
        identity.pi_uid
      );

      const data =
        await callGatewayRpc(
          "gateway_get_my_internal_funding_plan",
          {
            p_pi_uid:
              identity.pi_uid,

            p_project_id:
              project.id
          },
          "Internal funding plan is unavailable."
        );

      return res
        .status(200)
        .json({
          success: true,
          data: {
            project_code:
              project.project_code,

            network:
              MAINNET,

            funding_plan:
              data
          }
        });
    } catch (error) {
      const status =
        Number(error?.status) ||
        500;

      if (status >= 500) {
        console.error(
          "[ALBUKHR API] Internal funding-plan read error",
          error
        );
      }

      return res
        .status(status)
        .json({
          success: false,
          error:
            status >= 500
              ? "Unable to load Internal funding plan."
              : error.message
        });
    }
  }
);

router.post(
  "/api/contributor/project/funding-plan",
  async (req, res) => {
    try {
      const identity =
        await verifiedPiIdentity(
          req
        );

      const b = body(req);

      const project =
        await getContributorInternalProject(
          b.project_code
        );

      await assertContributorOwner(
        project,
        identity.pi_uid
      );

      const payload =
        fundingPayload(b);

      const data =
        await callGatewayRpc(
          "gateway_save_my_internal_funding_plan",
          {
            p_pi_uid:
              identity.pi_uid,

            p_project_id:
              project.id,

            p_business_stage:
              payload.businessStage,

            p_funding_purpose:
              payload.fundingPurpose,

            p_funding_mode:
              payload.fundingMode,

            p_existing_asset_base:
              payload.existingAssetBase,

            p_existing_verified_liquidity:
              payload.declaredExistingLiquidity,

            p_incremental_capital_requirement:
              payload.declaredIncrementalCapital,

            p_funding_window_start:
              payload.fundingWindowStart,

            p_funding_window_end:
              payload.fundingWindowEnd,

            p_operating_cycle_days:
              payload.operatingCycleDays,

            p_expected_capital_cycle_days:
              payload.expectedCapitalCycleDays,

            p_required_reserve:
              payload.requiredReserve,

            p_contingency_reserve:
              payload.contingencyReserve,

            p_notes:
              payload.notes,

            p_items:
              payload.items
          },
          "Internal funding plan could not be saved."
        );

      return res
        .status(200)
        .json({
          success: true,
          data: {
            project_code:
              project.project_code,

            network:
              MAINNET,

            funding_plan:
              data
          }
        });
    } catch (error) {
      const status =
        Number(error?.status) ||
        500;

      if (status >= 500) {
        console.error(
          "[ALBUKHR API] Internal funding-plan save error",
          error
        );
      }

      return res
        .status(status)
        .json({
          success: false,
          error:
            status >= 500
              ? "Unable to save Internal funding plan."
              : error.message
        });
    }
  }
);

router.post(
  "/api/contributor/project/funding-plan/submit",
  async (req, res) => {
    try {
      const identity =
        await verifiedPiIdentity(
          req
        );

      const b = body(req);

      const project =
        await getContributorInternalProject(
          b.project_code
        );

      await assertContributorOwner(
        project,
        identity.pi_uid
      );

      const data =
        await callGatewayRpc(
          "gateway_submit_my_internal_funding_plan",
          {
            p_pi_uid:
              identity.pi_uid,

            p_project_id:
              project.id
          },
          "Internal funding plan could not be submitted."
        );

      return res
        .status(200)
        .json({
          success: true,
          data: {
            project_code:
              project.project_code,

            network:
              MAINNET,

            funding_plan:
              data
          }
        });
    } catch (error) {
      const status =
        Number(error?.status) ||
        500;

      if (status >= 500) {
        console.error(
          "[ALBUKHR API] Internal funding-plan submit error",
          error
        );
      }

      return res
        .status(status)
        .json({
          success: false,
          error:
            status >= 500
              ? "Unable to submit Internal funding plan."
              : error.message
        });
    }
  }
);

const internalFundingGatewayRouter =
  router;

module.exports = {
  internalFundingGatewayRouter
};
