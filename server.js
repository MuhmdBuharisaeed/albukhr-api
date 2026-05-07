const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

/* ===============================
   ENV
=============================== */

const PI_API_KEY = process.env.PI_API_KEY;

/* ===============================
   HEALTH CHECK
=============================== */

app.get("/", (req, res) => {

  res.send("ALBUKHR PAYMENT API RUNNING 🚀");

});

/* ===============================
   PING
=============================== */

app.get("/ping", (req, res) => {

  res.send("alive");

});

/* ===============================
   APPROVE PAYMENT
=============================== */

app.post("/approve-payment", async (req, res) => {

  try {

    const { paymentId } = req.body;

    console.log("APPROVE PAYMENT:", paymentId);

    const result = await axios.post(

      `https://api.testnet.minepi.com/v2/payments/${paymentId}/approve`,

      {},

      {
        headers: {
          Authorization: `Key ${PI_API_KEY}`
        }
      }

    );

    console.log("APPROVED SUCCESS");

    res.send({
      success: true
    });

  } catch (err) {

    console.error(
      "APPROVE ERROR:",
      err.response?.data || err.message
    );

    res.status(500).send({
      success: false,
      error: "Approve failed"
    });

  }

});

/* ===============================
   COMPLETE PAYMENT
=============================== */

app.post("/complete-payment", async (req, res) => {

  try {

    const { paymentId, txid } = req.body;

    console.log(
      "COMPLETE PAYMENT:",
      paymentId,
      txid
    );

    const result = await axios.post(

      `https://api.testnet.minepi.com/v2/payments/${paymentId}/complete`,

      {
        txid
      },

      {
        headers: {
          Authorization: `Key ${PI_API_KEY}`
        }
      }

    );

    console.log("COMPLETE SUCCESS");

    res.send({
      success: true
    });

  } catch (err) {

    console.error(
      "COMPLETE ERROR:",
      err.response?.data || err.message
    );

    res.status(500).send({
      success: false,
      error: "Complete failed"
    });

  }

});

/* ===============================
   START SERVER
=============================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(
    "ALBUKHR PAYMENT SERVER RUNNING ON PORT",
    PORT
  );

});
