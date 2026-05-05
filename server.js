const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json());

/* ENV */
const PI_API_KEY = process.env.PI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

/* SUPABASE */
let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY
  );
} else {
  console.warn("⚠️ Supabase ENV not set");
}

/* ================= HEALTH ================= */
app.get("/", (req, res) => {
  res.send("ALBUKHR API RUNNING 🚀");
});

/* 🔥 IMPORTANT: KEEP SERVER AWAKE */
app.get("/ping", (req, res) => {
  res.send("alive");
});

/* ================= APPROVE ================= */
app.post("/approve-payment", async (req, res) => {

  const { paymentId } = req.body;

  if (!paymentId) {
    return res.status(400).send({ error: "Missing paymentId" });
  }

  try {

    await axios.post(
      `https://api.testnet.minepi.com/v2/payments/${paymentId}/approve`,
      {},
      {
        headers: {
          Authorization: `Key ${PI_API_KEY}`
        },
        timeout: 10000 // 🔥 prevent hanging
      }
    );

    console.log("✅ APPROVED:", paymentId);

    res.send({ success: true });

  } catch (err) {

    console.error("❌ APPROVE ERROR:",
      err.response?.data || err.message
    );

    res.status(500).send({ error: "Approve failed" });
  }

});

/* ================= COMPLETE ================= */
app.post("/approve-payment", async (req, res) => {

  const { paymentId } = req.body;

  try {

    const result = await axios.post(
      `https://api.testnet.minepi.com/v2/payments/${paymentId}/approve`,
      {},
      {
        headers: {
          Authorization: `Key ${process.env.PI_API_KEY}`
        }
      }
    );

    console.log("✅ APPROVED:", paymentId);

    res.send({ success: true });

  } catch (err) {

    console.error("❌ APPROVE ERROR:",
      err.response?.data || err.message
    );

    res.status(500).send({ error: "Approve failed" });
  }

});
/* ================= START ================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});
