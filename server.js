const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

let stakes = [];

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

app.get("/stakes",(req,res)=>{

  const uid =
    req.headers["x-user-id"] ||
    req.query.uid;

  if(!uid) return res.json([]);

  res.json(
    stakes.filter(s=>s.userId === uid)
  );

});

app.post("/withdraw",(req,res)=>{

  res.json({success:true});

});

app.listen(3000,()=>console.log("Running"));
