
/* ALBUKHR API — Mainnet Financial + Contributor + Internal Funding
 * + Internal Investment + Internal Liquidity + External Project
 * + Mainnet Identity + DApp Service v2
 *
 * Version: 2.3.0
 */
"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const { createMainnetApi } = require("./src/mainnet-api");
const { financialGatewayRouter } = require("./src/financial-gateway");
const { walletGatewayRouter } = require("./src/wallet-gateway");
const {
  contributorApplicationGatewayRouter
} = require("./src/contributor-application-gateway");
const { contributorGatewayRouter } = require("./src/contributor-gateway");

const {
  internalFundingGatewayRouter
} = require("./src/internal-funding-gateway");

const {
  internalInvestmentGatewayRouter
} = require("./src/internal-investment-gateway");

const {
  internalLiquidityGatewayRouter
} = require("./src/internal-liquidity-gateway");

const {
  externalProjectGatewayRouter
} = require("./src/external-project-gateway");

const {
  mainnetIdentityGatewayRouter
} = require("./src/mainnet-identity-gateway");


/* =========================================================
   APPLICATION INITIALIZATION
========================================================= */

const app = express();
const api = createMainnetApi();

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

app.disable("x-powered-by");
app.set("trust proxy", 1);


/* =========================================================
   CORS
========================================================= */

const allowedOrigins = String(
  process.env.ALLOWED_ORIGINS || ""
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: "cross-origin"
    }
  })
);


app.use(
  cors((req, callback) => {
    const origin = String(req.get("Origin") || "");
    const path = String(req.path || "");

    const isAdminSession =
      path === "/api/admin/session" ||
      path.startsWith("/api/admin/session/");

    const adminOrigin = String(
      process.env.ALBUKHR_ADMIN_SESSION_ORIGIN || ""
    ).trim();

    const isAllowedAdminOrigin =
      isAdminSession &&
      Boolean(adminOrigin) &&
      origin === adminOrigin;

    // Preserve the existing ALLOWED_ORIGINS behavior.
    const isExistingAllowedOrigin =
      allowedOrigins.length === 0 ||
      allowedOrigins.includes(origin);

    // Preserve server-to-server requests without an Origin header.
    if (!origin) {
      return callback(null, {
        origin: true,
        credentials: false,
        methods: [
          "GET",
          "POST",
          "PATCH",
          "PUT",
          "DELETE",
          "OPTIONS"
        ],
        allowedHeaders: [
          "Content-Type",
          "Authorization",
          "X-API-Key"
        ],
        preflightContinue: false,
        optionsSuccessStatus: 204
      });
    }

    // Keep rejecting origins that are not allowed by either policy.
    if (!isAllowedAdminOrigin && !isExistingAllowedOrigin) {
      return callback(new Error("Origin is not allowed."));
    }

    return callback(null, {
      // Reflect the exact request Origin; never use "*".
      origin: true,
      credentials: isAllowedAdminOrigin,
      methods: [
        "GET",
        "POST",
        "PATCH",
        "PUT",
        "DELETE",
        "OPTIONS"
      ],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-API-Key"
      ],
      preflightContinue: false,
      optionsSuccessStatus: 204
    });
  })
);


/* =========================================================
   EXTERNAL PROJECT LOGO RAW BODY
========================================================= */

// This route receives image bytes rather than JSON.
// The gateway must enforce the actual project-logo file limit.
app.use(
  "/api/external-project/:applicationId/logo",
  express.raw({
    type: () => true,
    limit: "2mb"
  })
);


/* =========================================================
   JSON BODY
========================================================= */

app.use(
  express.json({
    limit: "100kb"
  })
);


/* =========================================================
   GLOBAL RATE LIMIT
========================================================= */

app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false
  })
);


/* =========================================================
   ROOT
========================================================= */

app.get("/", (_req, res) =>
  res.status(200).json({
    service: "albukhr-api",
    status: "ok",
    network: "mainnet",
    version: "2.3.0"
  })
);


/* =========================================================
   HEALTH
========================================================= */

app.get("/health", async (_req, res) => {
  try {
    const health = await api.health();

    return res
      .status(health.status === "ok" ? 200 : 503)
      .json(health);

  } catch (error) {
    console.error(
      "[ALBUKHR API] Health check failed:",
      error
    );

    return res.status(503).json({
      status: "error",
      service: "albukhr-api",
      network: "mainnet",
      error: "Health check failed."
    });
  }
});


/* =========================================================
   SUPABASE STATUS
========================================================= */

app.get("/supabase-status", async (_req, res) => {
  try {
    const status = await api.databaseStatus();

    return res
      .status(status.status === "ok" ? 200 : 503)
      .json(status);

  } catch (error) {
    console.error(
      "[ALBUKHR API] Supabase status failed:",
      error
    );

    return res.status(503).json({
      status: "error",
      network: "mainnet",
      error: "Supabase status unavailable."
    });
  }
});


/* =========================================================
   MAINNET STATUS
========================================================= */

app.get(
  "/mainnet-status",
  api.requireOpsKey,
  async (_req, res) => {
    try {
      return res
        .status(200)
        .json(await api.mainnetStatus());

    } catch (error) {
      console.error(
        "[ALBUKHR API] Mainnet status failed:",
        error
      );

      return res.status(503).json({
        success: false,
        network: "mainnet",
        error: "Mainnet Horizon status unavailable."
      });
    }
  }
);


/* =========================================================
   WALLET STATUS
========================================================= */

app.get(
  "/wallet-status",
  api.requireOpsKey,
  async (_req, res) => {
    try {
      return res
        .status(200)
        .json(await api.walletStatus());

    } catch (error) {
      console.error(
        "[ALBUKHR API] Wallet status failed:",
        error
      );

      return res.status(503).json({
        success: false,
        network: "mainnet",
        error: "Wallet status unavailable."
      });
    }
  }
);


/* =========================================================
   CONTRIBUTOR APPLICATION FORM ONE
   + INVITATION IDENTITY GUARD
========================================================= */

/*
 * Important ordering:
 * - Mount Form One routes.
 * - Check the verified Pi identity against application-bound
 *   invitations before the legacy onboarding handlers run.
 * - Keep the existing Contributor gateway unchanged.
 *
 * Do not move contributorGatewayRouter above this router.
 */
app.use(contributorApplicationGatewayRouter);


/* =========================================================
   EXISTING CONTRIBUTOR GATEWAY
========================================================= */

app.use(contributorGatewayRouter);


/* =========================================================
   INTERNAL FUNDING GATEWAY
========================================================= */

app.use(internalFundingGatewayRouter);


/* =========================================================
   INTERNAL INVESTMENT GATEWAY
========================================================= */

app.use(internalInvestmentGatewayRouter);


/* =========================================================
   INTERNAL LIQUIDITY GATEWAY
========================================================= */

app.use(internalLiquidityGatewayRouter);


/* =========================================================
   MAINNET IDENTITY GATEWAY
========================================================= */

/*
 * Provides the trusted Mainnet identity endpoint.
 *
 * Expected mount:
 * POST /api/identity/login
 *
 * The router must independently verify the Pi access token.
 * Do not accept a browser-supplied Pi UID as proof of identity.
 *
 * This mount does not automatically migrate existing frontend
 * login callers; that requires a separate frontend change.
 */
app.use(
  "/api/identity",
  mainnetIdentityGatewayRouter
);


/* =========================================================
   EXTERNAL PROJECT TRUSTED GATEWAY
========================================================= */

app.use(
  "/api/external-project",
  externalProjectGatewayRouter
);


/* =========================================================
   DAPP SERVICE V2 GATEWAY
========================================================= */

/*
 * Disabled by default.
 *
 * Enable only when:
 * 1. DAPP_SERVICE_V2_ENABLED=true
 * 2. The gateway's required environment variables are configured.
 * 3. Its database schema and RLS policies are verified.
 * 4. Consent, authentication, and request authorization are tested.
 *
 * This is the Mainnet API. Do not point its Supabase configuration
 * at the Testnet project.
 *
 * Payment channels must remain disabled until payment handling
 * has been separately reviewed and approved.
 */
const dappServiceV2Enabled =
  String(process.env.DAPP_SERVICE_V2_ENABLED || "")
    .trim()
    .toLowerCase() === "true";

if (dappServiceV2Enabled) {
  const {
    createDappServiceV2GatewayRouter
  } = require("./src/dapp-service-v2-gateway");

  app.use(
    "/api/dapp-service/v2",
    createDappServiceV2GatewayRouter()
  );

  console.log(
    "[ALBUKHR API] DApp Service v2 gateway enabled."
  );

} else {
  console.log(
    "[ALBUKHR API] DApp Service v2 gateway disabled."
  );
}


/* =========================================================
   MAINNET FINANCIAL GATEWAY
========================================================= */

/* Additive, read-only Wallet snapshot route. */
app.use(walletGatewayRouter);

app.use(financialGatewayRouter);

/* =========================================================
   LEGACY FINANCIAL UNAVAILABLE ROUTES
========================================================= */

for (const route of [
  "/approve",
  "/complete",
  "/withdraw",
  "/pay-withdraw"
]) {
  app.post(route, api.financialUnavailable);
}


/* =========================================================
   404 HANDLER
========================================================= */

app.use((req, res) =>
  res.status(404).json({
    success: false,
    error: "Route not found.",
    path: req.path
  })
);


/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use((error, _req, res, _next) => {
  if (error?.message === "Origin is not allowed.") {
    return res.status(403).json({
      success: false,
      error: "Origin is not allowed."
    });
  }

  // Handle body-parser errors without exposing internal details.
  if (error?.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      error: "Request body is too large."
    });
  }

  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      error: "Invalid JSON request body."
    });
  }

  console.error(
    "[ALBUKHR API] Unhandled error:",
    error
  );

  return res.status(500).json({
    success: false,
    error: "Internal server error."
  });
});


/* =========================================================
   SERVER START
========================================================= */

const server = app.listen(PORT, HOST, () => {
  console.log(
    `ALBUKHR MAINNET API v2.3.0 running on ${HOST}:${PORT}`
  );
});


/* =========================================================
   PROCESS ERROR HANDLING
========================================================= */

process.on("unhandledRejection", (reason) => {
  console.error(
    "[ALBUKHR API] Unhandled promise rejection:",
    reason
  );
});

process.on("uncaughtException", (error) => {
  console.error(
    "[ALBUKHR API] Uncaught exception:",
    error
  );

  server.close(() => {
    process.exit(1);
  });
});


/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `[ALBUKHR API] ${signal} received. Shutting down...`
  );

  server.close(() => {
    console.log("[ALBUKHR API] Server closed.");
    process.exit(0);
  });

  setTimeout(() => {
    console.error(
      "[ALBUKHR API] Graceful shutdown timed out."
    );

    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
