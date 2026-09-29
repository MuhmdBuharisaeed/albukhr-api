/* ALBUKHR API — Mainnet financial + Contributor gateway v2.3.0 */
"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const { createMainnetApi } = require("./src/mainnet-api");
const { financialGatewayRouter } = require("./src/financial-gateway");
const { contributorGatewayRouter } = require("./src/contributor-gateway");

const app = express();
const api = createMainnetApi();

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

app.disable("x-powered-by");
app.set("trust proxy", 1);

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);

      // Preserve the existing API behavior: when ALLOWED_ORIGINS is not
      // configured, do not block browser origins at this middleware layer.
      // Production should set ALLOWED_ORIGINS explicitly.
      if (allowedOrigins.length === 0) return callback(null, true);

      if (allowedOrigins.includes(origin)) return callback(null, true);

      return callback(new Error("Origin is not allowed."));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    credentials: false
  })
);

app.use(express.json({ limit: "100kb" }));

app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false
  })
);

app.get("/", (_req, res) =>
  res.status(200).json({
    service: "albukhr-api",
    status: "ok",
    network: "mainnet",
    version: "2.3.0"
  })
);

app.get("/health", async (_req, res) => {
  try {
    const health = await api.health();

    return res
      .status(health.status === "ok" ? 200 : 503)
      .json(health);
  } catch (error) {
    console.error("[ALBUKHR API] Health check failed:", error);

    return res.status(503).json({
      status: "error",
      service: "albukhr-api",
      network: "mainnet",
      error: "Health check failed."
    });
  }
});

app.get("/supabase-status", async (_req, res) => {
  try {
    const status = await api.databaseStatus();

    return res
      .status(status.status === "ok" ? 200 : 503)
      .json(status);
  } catch (error) {
    console.error("[ALBUKHR API] Supabase status failed:", error);

    return res.status(503).json({
      status: "error",
      network: "mainnet",
      error: "Supabase status unavailable."
    });
  }
});

app.get("/mainnet-status", api.requireOpsKey, async (_req, res) => {
  try {
    return res.status(200).json(await api.mainnetStatus());
  } catch (error) {
    console.error("[ALBUKHR API] Mainnet status failed:", error);

    return res.status(503).json({
      success: false,
      network: "mainnet",
      error: "Mainnet Horizon status unavailable."
    });
  }
});

app.get("/wallet-status", api.requireOpsKey, async (_req, res) => {
  try {
    return res.status(200).json(await api.walletStatus());
  } catch (error) {
    console.error("[ALBUKHR API] Wallet status failed:", error);

    return res.status(503).json({
      success: false,
      network: "mainnet",
      error: "Wallet status unavailable."
    });
  }
});

/*
 * Contributor gateway
 *
 * The API verifies the Pi access token server-side and then uses the
 * service-role-only Supabase gateway RPCs. The browser never supplies the
 * authoritative Pi UID to the database.
 */
app.use(contributorGatewayRouter);

/* Existing Mainnet financial gateway. */
app.use(financialGatewayRouter);

for (const route of ["/approve", "/complete", "/withdraw", "/pay-withdraw"]) {
  app.post(route, api.financialUnavailable);
}

app.use((req, res) =>
  res.status(404).json({
    success: false,
    error: "Route not found.",
    path: req.path
  })
);

app.use((error, _req, res, _next) => {
  if (error?.message === "Origin is not allowed.") {
    return res.status(403).json({
      success: false,
      error: "Origin is not allowed."
    });
  }

  console.error("[ALBUKHR API] Unhandled error:", error);

  return res.status(500).json({
    success: false,
    error: "Internal server error."
  });
});

const server = app.listen(PORT, HOST, () =>
  console.log(`ALBUKHR MAINNET API v2.3.0 running on ${HOST}:${PORT}`)
);

process.on("unhandledRejection", (reason) =>
  console.error("[ALBUKHR API] Unhandled promise rejection:", reason)
);

process.on("uncaughtException", (error) => {
  console.error("[ALBUKHR API] Uncaught exception:", error);

  server.close(() => process.exit(1));
});

function shutdown(signal) {
  console.log(`[ALBUKHR API] ${signal} received. Shutting down...`);

  server.close(() => {
    console.log("[ALBUKHR API] Server closed.");
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
