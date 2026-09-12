"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const { createMainnetApi } = require("./src/mainnet-api");

const app = express();
const api = createMainnetApi();

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

/*
 * ALBUKHR API
 * Mainnet-only backend
 *
 * IMPORTANT:
 * - No dotenv dependency is required.
 * - Render provides environment variables directly.
 * - This API is locked to ALBUKHR Mainnet.
 * - Financial settlement remains disabled until the
 *   required Mainnet Supabase financial backend exists.
 */

/* -------------------------------------------------------
 * BASIC APPLICATION SECURITY
 * ----------------------------------------------------- */

app.disable("x-powered-by");

app.set("trust proxy", 1);

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: "cross-origin",
    },
  })
);

/* -------------------------------------------------------
 * CORS
 * ----------------------------------------------------- */

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      /*
       * Server-to-server requests normally have no Origin header.
       * Those requests are allowed.
       */
      if (!origin) {
        return callback(null, true);
      }

      /*
       * If ALLOWED_ORIGINS is not configured, allow the request
       * for now. This preserves current deployment compatibility.
       *
       * For production browser traffic, configure:
       *
       * ALLOWED_ORIGINS=https://app.albukhr.com
       */
      if (allowedOrigins.length === 0) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Origin is not allowed."));
    },

    methods: ["GET", "POST", "OPTIONS"],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-API-Key",
    ],

    credentials: false,
  })
);

/* -------------------------------------------------------
 * REQUEST BODY LIMIT
 * ----------------------------------------------------- */

app.use(
  express.json({
    limit: "100kb",
  })
);

/* -------------------------------------------------------
 * EXTERNAL PROJECT TRUSTED GATEWAY
 *
 * Mainnet External Project operations must pass through
 * Pi-token verification before reaching Supabase.
 * ----------------------------------------------------- */

app.use(
  "/api/external-project",
  externalProjectGatewayRouter
);

/* -------------------------------------------------------
 * GLOBAL RATE LIMIT
 * ----------------------------------------------------- */

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  })
);

/* -------------------------------------------------------
 * ROOT
 * ----------------------------------------------------- */

app.get("/", (_req, res) => {
  res.status(200).json({
    service: "albukhr-api",
    status: "ok",
    network: "mainnet",
    version: "2.0.0",
  });
});

/* -------------------------------------------------------
 * HEALTH CHECK
 *
 * Render uses this endpoint to determine whether the
 * service is healthy.
 * ----------------------------------------------------- */

app.get("/health", async (_req, res) => {
  try {
    const health = await api.health();

    res
      .status(health.status === "ok" ? 200 : 503)
      .json(health);
  } catch (error) {
    console.error("[ALBUKHR API] Health check failed:", error);

    res.status(503).json({
      status: "error",
      service: "albukhr-api",
      network: "mainnet",
      error: "Health check failed.",
    });
  }
});

/* -------------------------------------------------------
 * SUPABASE STATUS
 * ----------------------------------------------------- */

app.get("/supabase-status", async (_req, res) => {
  try {
    const status = await api.databaseStatus();

    res
      .status(status.status === "ok" ? 200 : 503)
      .json(status);
  } catch (error) {
    console.error(
      "[ALBUKHR API] Supabase status failed:",
      error
    );

    res.status(503).json({
      status: "error",
      network: "mainnet",
      error: "Database status unavailable.",
    });
  }
});

/* -------------------------------------------------------
 * MAINNET HORIZON STATUS
 *
 * Protected with OPERATIONS_API_KEY.
 * ----------------------------------------------------- */

app.get(
  "/mainnet-status",
  api.requireOpsKey,
  async (_req, res) => {
    try {
      const status = await api.mainnetStatus();

      res.status(200).json(status);
    } catch (error) {
      console.error(
        "[ALBUKHR API] Mainnet status failed:",
        error
      );

      res.status(503).json({
        success: false,
        network: "mainnet",
        error: "Mainnet Horizon status unavailable.",
      });
    }
  }
);

/* -------------------------------------------------------
 * WALLET STATUS
 *
 * Protected with OPERATIONS_API_KEY.
 *
 * IMPORTANT:
 * This only exposes wallet PUBLIC configuration.
 * The private seed is never returned.
 * ----------------------------------------------------- */

app.get(
  "/wallet-status",
  api.requireOpsKey,
  async (_req, res) => {
    try {
      const status = await api.walletStatus();

      res.status(200).json(status);
    } catch (error) {
      console.error(
        "[ALBUKHR API] Wallet status failed:",
        error
      );

      res.status(503).json({
        success: false,
        network: "mainnet",
        error: "Wallet status unavailable.",
      });
    }
  }
);

/* -------------------------------------------------------
 * FINANCIAL ENDPOINTS
 *
 * These endpoints intentionally remain disabled.
 *
 * Current Mainnet Supabase does NOT contain the required:
 *
 * - stakes
 * - transactions
 * - withdraw_requests
 * - project_treasury
 * - project_treasury_transactions
 * - settlement RPC
 *
 * Therefore the API must NOT pretend that settlement works.
 * ----------------------------------------------------- */

const financialRoutes = [
  "/approve",
  "/complete",
  "/withdraw",
  "/pay-withdraw",
  "/api/pi-project-treasury-payment",
];

for (const route of financialRoutes) {
  app.post(
    route,
    api.financialUnavailable
  );
}

/* -------------------------------------------------------
 * 404 HANDLER
 * ----------------------------------------------------- */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found.",
    path: req.path,
  });
});

/* -------------------------------------------------------
 * GLOBAL ERROR HANDLER
 * ----------------------------------------------------- */

app.use((error, _req, res, _next) => {
  if (error?.message === "Origin is not allowed.") {
    return res.status(403).json({
      success: false,
      error: "Origin is not allowed.",
    });
  }

  console.error(
    "[ALBUKHR API] Unhandled error:",
    error
  );

  return res.status(500).json({
    success: false,
    error: "Internal server error.",
  });
});

/* -------------------------------------------------------
 * START SERVER
 *
 * Render requires the web service to listen on the
 * supplied PORT and a publicly reachable interface.
 * ----------------------------------------------------- */

const server = app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `ALBUKHR MAINNET API v2.0.0 running on ${HOST}:${PORT}`
    );
  }
);

/* -------------------------------------------------------
 * PROCESS ERROR HANDLING
 * ----------------------------------------------------- */

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

  /*
   * Let the process manager/Render restart the service
   * after an unrecoverable exception.
   */
  server.close(() => {
    process.exit(1);
  });
});

/* -------------------------------------------------------
 * GRACEFUL SHUTDOWN
 * ----------------------------------------------------- */

function shutdown(signal) {
  console.log(
    `[ALBUKHR API] ${signal} received. Shutting down...`
  );

  server.close(() => {
    console.log("[ALBUKHR API] Server closed.");
    process.exit(0);
  });

  /*
   * Force shutdown if connections do not close promptly.
   */
  setTimeout(() => {
    console.error(
      "[ALBUKHR API] Forced shutdown after timeout."
    );

    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const {
  externalProjectGatewayRouter
} = require("./src/external-project-gateway");
