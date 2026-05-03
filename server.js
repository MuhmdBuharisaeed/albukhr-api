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
const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY
);

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
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
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
app.post("/complete-payment", async (req, res) => {

  const { paymentId, txid } = req.body;

  if (!paymentId || !txid) {
    return res.status(400).send({ error: "Missing data" });
  }

  try {

    const result = await axios.post(
      `https://api.minepi.com/v2/payments/${paymentId}/complete`,
      { txid },
      {
        headers: {
          Authorization: `Key ${PI_API_KEY}`
        },
        timeout: 10000
      }
    );

    const payment = result.data;
    const metadata = payment.metadata;

    console.log("🎉 COMPLETED:", paymentId);

    // 🔐 SAVE TO SUPABASE
    const { error } = await supabase
      .from("stakes")
      .insert([{
        user_id: metadata.user,
        project: metadata.project,
        amount: payment.amount,
        duration: metadata.duration,
        reward: 0,
        withdrawnReward: 0,
        created_at: new Date().toISOString()
      }]);

    if (error) {
      console.error("❌ SUPABASE:", error);
    }

    res.send({ success: true });

  } catch (err) {

    console.error("❌ COMPLETE ERROR:",
      err.response?.data || err.message
    );

    res.status(500).send({ error: "Complete failed" });
  }

});

/* ================= START ================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});
