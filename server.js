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

  const {userId, project, amount} = req.body;

  if(!userId || !project || !amount){
    return res.json({success:false,error:"Invalid request"});
  }

  let remaining = Number(amount);

  /* FILTER BY PROJECT */
  const userStakes =
    stakes.filter(s =>
      s.userId === userId &&
      s.project === project
    );

  if(userStakes.length === 0){
    return res.json({
      success:false,
      error:"No stakes in this project"
    });
  }

  /* LOOP THROUGH PROJECT STAKES */
  for(let s of userStakes){

    const available =
      (s.reward || 0) -
      (s.withdrawnReward || 0);

    if(available > 0 && remaining > 0){

      const take =
        Math.min(available, remaining);

      s.withdrawnReward =
        (s.withdrawnReward || 0) + take;

      remaining -= take;

    }

  }

  if(remaining > 0){
    return res.json({
      success:false,
      error:"Insufficient project reward"
    });
  }

  res.json({success:true});

});

app.listen(3000,()=>console.log("Running"));
