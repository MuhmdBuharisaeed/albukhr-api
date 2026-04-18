const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

let stakes = [];

/* =========================
   STAKE
========================= */
app.post("/stake",(req,res)=>{

  const {userId, project, amount, duration, txid} = req.body;

  if(!userId || !txid){
    return res.json({success:false});
  }

  const stake = {
    id:"ST-"+Date.now(),
    userId,
    project,
    amount,
    duration,
    reward: amount * 0.05,
    withdrawnReward:0,
    status:"Successful",
    timestamp:Date.now(),
    txid
  };

  stakes.push(stake);

  res.json({success:true, stake});

});

/* =========================
   GET STAKES
========================= */
app.get("/stakes",(req,res)=>{

  const uid = req.headers["x-user-id"];

  if(!uid) return res.json([]);

  res.json(
    stakes.filter(s=>s.userId===uid)
  );

});

/* =========================
   WITHDRAW
========================= */
app.post("/withdraw",(req,res)=>{
  res.json({success:true});
});

/* =========================
   🔥 COMPLETE PAYMENT (IMPORTANT)
========================= */
app.post("/complete-payment",(req,res)=>{

  const {paymentId, txid} = req.body;

  console.log("✅ Payment completed:", paymentId, txid);

  res.json({success:true});

});

/* =========================
   START SERVER
========================= */
app.listen(3000,()=>console.log("Running"));
