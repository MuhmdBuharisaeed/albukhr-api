/* ALBUKHR API — Mainnet financial + Contributor + Internal Funding + Internal Investment + Internal Liquidity + External Project gateway v2.3.0 */
"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const { createMainnetApi } = require("./src/mainnet-api");
const { financialGatewayRouter } = require("./src/financial-gateway");
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

/*
 * External Project Trusted Gateway.
 *
 * Trust boundary:
 *
 * Browser
 *   ↓
 * Pi access token
 *   ↓
 * Pi Platform API verification
 *   ↓
 * verified Pi UID
 *   ↓
 * External Project applicant RPCs
 *
 * The browser does not become the authoritative source
 * of the applicant identity.
 */
const {
  externalProjectGatewayRouter
} = require("./src/external-project-gateway");


const app = express();
const api = createMainnetApi();

const PORT = Number(
  process.env.PORT || 3000
);

const HOST = "0.0.0.0";


/* =========================================================
   BASIC APPLICATION HARDENING
========================================================= */

app.disable("x-powered-by");

app.set(
  "trust proxy",
  1
);


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
  cors({
    origin(origin, callback) {
      /*
       * Non-browser requests without Origin remain allowed.
       * This preserves existing API/server-to-server behavior.
       */
      if (!origin) {
        return callback(null, true);
      }

      /*
       * Preserve existing behavior when no explicit
       * ALLOWED_ORIGINS environment variable is configured.
       */
      if (allowedOrigins.length === 0) {
        return callback(null, true);
      }

      if (
        allowedOrigins.includes(origin)
      ) {
        return callback(null, true);
      }

      return callback(
        new Error(
          "Origin is not allowed."
        )
      );
    },

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

    credentials: false
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

app.get(
  "/",
  (_req, res) =>
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

app.get(
  "/health",
  async (_req, res) => {
    try {
      const health =
        await api.health();

      return res
        .status(
          health.status === "ok"
            ? 200
            : 503
        )
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
        error:
          "Health check failed."
      });
    }
  }
);


/* =========================================================
   SUPABASE STATUS
========================================================= */

app.get(
  "/supabase-status",
  async (_req, res) => {
    try {
      const status =
        await api.databaseStatus();

      return res
        .status(
          status.status === "ok"
            ? 200
            : 503
        )
        .json(status);

    } catch (error) {
      console.error(
        "[ALBUKHR API] Supabase status failed:",
        error
      );

      return res.status(503).json({
        status: "error",
        network: "mainnet",
        error:
          "Supabase status unavailable."
      });
    }
  }
);


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
        .json(
          await api.mainnetStatus()
        );

    } catch (error) {
      console.error(
        "[ALBUKHR API] Mainnet status failed:",
        error
      );

      return res.status(503).json({
        success: false,
        network: "mainnet",
        error:
          "Mainnet Horizon status unavailable."
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
        .json(
          await api.walletStatus()
        );

    } catch (error) {
      console.error(
        "[ALBUKHR API] Wallet status failed:",
        error
      );

      return res.status(503).json({
        success: false,
        network: "mainnet",
        error:
          "Wallet status unavailable."
      });
    }
  }
);


/* =========================================================
   CONTRIBUTOR GATEWAY
========================================================= */

/*
 * Existing Contributor gateway.
 *
 * Preserved unchanged.
 */
app.use(
  contributorGatewayRouter
);


/* =========================================================
   CONTRIBUTOR INTERNAL FUNDING GATEWAY
========================================================= */

/*
 * Funding-plan submission and assessment flow
 * are kept separate from the liquidity payment
 * gateway and from Core Financial.
 *
 * Existing contract preserved.
 */
app.use(
  internalFundingGatewayRouter
);


/* =========================================================
   CONTRIBUTOR INTERNAL INVESTMENT GATEWAY
========================================================= */

/*
 * Existing Contributor Internal Investment gateway.
 *
 * Existing contract preserved.
 */
app.use(
  internalInvestmentGatewayRouter
);


/* =========================================================
   CONTRIBUTOR INTERNAL LIQUIDITY GATEWAY
========================================================= */

/*
 * Existing Contributor Internal Liquidity gateway.
 *
 * Existing contract preserved.
 */
app.use(
  internalLiquidityGatewayRouter
);


/* =========================================================
   EXTERNAL PROJECT TRUSTED GATEWAY
========================================================= */

/*
 * External Project security migration layer.
 *
 * IMPORTANT:
 *
 * This gateway is intentionally additive.
 *
 * It does NOT remove or revoke the existing applicant
 * Supabase RPC permissions at this stage.
 *
 * During migration:
 *
 * Browser
 *   ↓
 * Pi access token
 *   ↓
 * externalProjectGatewayRouter
 *   ↓
 * Pi Platform /v2/me verification
 *   ↓
 * trusted Pi UID
 *   ↓
 * existing applicant RPC
 *
 * This allows the frontend callers to migrate
 * incrementally without immediately breaking
 * existing pages.
 */
app.use(
  externalProjectGatewayRouter
);


/* =========================================================
   EXISTING MAINNET FINANCIAL GATEWAY
========================================================= */

/*
 * Existing Mainnet financial gateway.
 *
 * Core financial path preserved unchanged.
 */
app.use(
  financialGatewayRouter
);


/* =========================================================
   LEGACY FINANCIAL UNAVAILABLE ROUTES
========================================================= */

/*
 * Preserve existing unavailable financial routes.
 */
for (
  const route of [
    "/approve",
    "/complete",
    "/withdraw",
    "/pay-withdraw"
  ]
) {
  app.post(
    route,
    api.financialUnavailable
  );
}


/* =========================================================
   404 HANDLER
========================================================= */

app.use(
  (req, res) =>
    res.status(404).json({
      success: false,
      error: "Route not found.",
      path: req.path
    })
);


/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {

    /*
     * CORS rejection.
     */
    if (
      error?.message ===
      "Origin is not allowed."
    ) {
      return res.status(403).json({
        success: false,
        error:
          "Origin is not allowed."
      });
    }


    /*
     * Preserve existing server error
     * behavior for all other failures.
     */
    console.error(
      "[ALBUKHR API] Unhandled error:",
      error
    );


    return res.status(500).json({
      success: false,
      error:
        "Internal server error."
    });
  }
);


/* =========================================================
   SERVER START
========================================================= */

const server = app.listen(
  PORT,
  HOST,
  () =>
    console.log(
      `ALBUKHR MAINNET API v2.3.0 running on ${HOST}:${PORT}`
    )
);


/* =========================================================
   PROCESS ERROR HANDLING
========================================================= */

process.on(
  "unhandledRejection",
  (reason) =>
    console.error(
      "[ALBUKHR API] Unhandled promise rejection:",
      reason
    )
);


process.on(
  "uncaughtException",
  (error) => {

    console.error(
      "[ALBUKHR API] Uncaught exception:",
      error
    );

    server.close(
      () =>
        process.exit(1)
    );
  }
);


/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

function shutdown(signal) {

  console.log(
    `[ALBUKHR API] ${signal} received. Shutting down...`
  );


  server.close(
    () => {

      console.log(
        "[ALBUKHR API] Server closed."
      );

      process.exit(0);
    }
  );


  setTimeout(
    () => process.exit(1),
    10_000
  ).unref();
}


process.on(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
);


process.on(
  "SIGINT",
  () =>
    shutdown("SIGINT")
);
