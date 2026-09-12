/* ALBUKHR API — server.js replacement for financial gateway integration */

"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const { createMainnetApi } = require("./src/mainnet-api");
const { financialGatewayRouter } = require("./src/financial-gateway");

const app = express();
const api = createMainnetApi();

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",").map((value) => value.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed."));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  credentials: false
}));

app.use(express.json({ limit: "100kb" }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

app.get("/", (_req, res) => {
  res.status(200).json({
    service: "albukhr-api",
    status: "ok",
    network: "mainnet",
    version: "2.1.0"
  });
});

app.get("/health", async (_req, res) => {
  try {
    const health = await api.health();
    res.status(health.status === "ok" ? 200 : 503).json(health);
  } catch (error) {
    console.error("[ALBUKHR API] Health check failed:", error);
    res.status(503).json({
      status: "error", service: "albukhr-api", network: "mainnet",
      error: "Health check failed."
    });
  }
});

app.get("/supabase-status", async (_req, res) => {
  try {
    const status = await api.databaseStatus();
    res.status(status.status === "ok" ? 200 : 503).json(status);
  } catch (error) {
    console.error("[ALBUKHR API] Supabase status failed:", error);
    res.status(503).json({
      status: "error", network: "mainnet",
      error: "Database status unavailable."
    });
  }
});

app.get("/mainnet-status", api.requireOpsKey, async (_req, res) => {
  try {
    res.status(200).json(await api.mainnetStatus());
  } catch (error) {
    console.error("[ALBUKHR API] Mainnet status failed:", error);
    res.status(503).json({
      success: false, network: "mainnet",
      error: "Mainnet Horizon status unavailable."
    });
  }
});

app.get("/wallet-status", api.requireOpsKey, async (_req, res) => {
  try {
    res.status(200).json(await api.walletStatus());
  } catch (error) {
    console.error("[ALBUKHR API] Wallet status failed:", error);
    res.status(503).json({
      success: false, network: "mainnet",
      error: "Wallet status unavailable."
    });
  }
});

/*
 * FINANCIAL GATEWAY
 * Pi Bearer token -> Pi /v2/me -> Pi /v2/payments/:id
 * -> project/treasury verification -> atomic settlement RPC.
 */
app.use(financialGatewayRouter);

/*
 * Other financial endpoints remain intentionally disabled.
 * They are not part of the liquidity-settlement implementation.
 */
for (const route of ["/approve", "/complete", "/withdraw", "/pay-withdraw"]) {
  app.post(route, api.financialUnavailable);
}

app.use((req, res) => {
  res.status(404).json({
    success: false, error: "Route not found.", path: req.path
  });
});

app.use((error, _req, res, _next) => {
  if (error?.message === "Origin is not allowed.") {
    return res.status(403).json({
      success: false, error: "Origin is not allowed."
    });
  }
  console.error("[ALBUKHR API] Unhandled error:", error);
  return res.status(500).json({
    success: false, error: "Internal server error."
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`ALBUKHR MAINNET API v2.1.0 running on ${HOST}:${PORT}`);
});

process.on("unhandledRejection", (reason) => {
  console.error("[ALBUKHR API] Unhandled promise rejection:", reason);
});

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
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
