console.log("🔥 NEW SERVER FILE LOADED");

const express = require("express");
const cors = require("cors");
const Pi = require("pi-backend");

const app = express();

app.use(cors());
app.use(express.json());

Pi.init({
  apiKey: process.env.PI_API_KEY,
  walletPrivateSeed: process.env.WALLET_PRIVATE_SEED,
  sandbox: true
});

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

app.post("/approve-payment", async (req,res)=>{

  try{

    const { paymentId } = req.body;

    console.log("APPROVING:", paymentId);

    await Pi.approvePayment(paymentId);

    console.log("APPROVED SUCCESS");

    res.send({
   success:true
});

  }catch(err){

    console.error(err);

    res.status(500).send({
      success:false,
      error:err.message
    });

  }

});

/* ===============================
   COMPLETE PAYMENT
=============================== */

app.post("/complete-payment", async (req,res)=>{

  try{

    const { paymentId, txid } = req.body;

    console.log("COMPLETING:", paymentId);

    await Pi.completePayment(paymentId, txid);

    console.log("COMPLETE SUCCESS");

    res.send({
   success:true
});

  }catch(err){

    console.error(err);

    res.status(500).send({
      success:false,
      error:err.message
    });

  }

});

/* ===============================
   START SERVER
=============================== */

const PORT = process.env.PORT || 3000;

app.get("/check-key", (req, res) => {

res.json({
hasKey: !!process.env.PI_API_KEY,
preview: process.env.PI_API_KEY
? process.env.PI_API_KEY.slice(0,10) + "..."
: "NO KEY"
});

});

app.listen(PORT, () => {

  console.log(
    "ALBUKHR PAYMENT SERVER RUNNING ON PORT",
    PORT
  );

});
