use strict";

const express = require("express");
const { supabase } = require("./supabase-client");
const { getPayment, approvePayment, completePayment, getPioneer, verifyPaymentMetadata } = require("./pi-client");

const router = express.Router();
const MAINNET = "mainnet";

function httpError(status,message){const e=new Error(message);e.status=status;return e;}
function requireBearer(req){const value=String(req.headers.authorization||"").trim();if(!value.toLowerCase().startsWith("bearer "))throw httpError(401,"Pi authentication token is required.");const token=value.slice(7).trim();if(!token)throw httpError(401,"Pi authentication token is required.");return token;}
function clean(value,field,max=200){const v=String(value||"").trim();if(!v||v.length>max)throw httpError(400,`${field} is invalid.`);return v;}
function positiveAmount(value){const n=Number(value);if(!Number.isFinite(n)||n<=0||n>1000000000)throw httpError(400,"amount is invalid.");return n;}
async function verifiedPiIdentity(req){const token=requireBearer(req);const pioneer=await getPioneer(token);const piUid=String(pioneer.uid||"").trim();if(!piUid)throw httpError(401,"Pi identity could not be verified.");return {pi_uid:piUid};}

router.post("/api/withdrawal-request",async(req,res)=>{
  try{
    const identity=await verifiedPiIdentity(req);
    const b=req.body&&typeof req.body==="object"&&!Array.isArray(req.body)?req.body:{};
    const stakeId=clean(b.stake_id,"stake_id",100);
    const withdrawalType=clean(b.withdrawal_type,"withdrawal_type",20);
    if(!["reward","capital"].includes(withdrawalType))throw httpError(400,"withdrawal_type is invalid.");
    const requestedAmount=positiveAmount(b.requested_amount);
    const {data,error}=await supabase.rpc("create_my_withdrawal_request",{
      p_pi_uid:identity.pi_uid,
      p_stake_id:stakeId,
      p_withdrawal_type:withdrawalType,
      p_requested_amount:requestedAmount
    });
    if(error){
      console.error("[ALBUKHR API] Withdrawal request RPC failed",{code:error.code,message:error.message});
      throw httpError(409,error.message||"Withdrawal request was rejected.");
    }
    return res.status(200).json(data);
  }catch(error){
    const status=Number(error?.status)||500;
    if(status>=500)console.error("[ALBUKHR API] Withdrawal request error",error);
    return res.status(status).json({success:false,error:status>=500?"Withdrawal request failed.":error.message});
  }
});

router.get("/api/my-withdrawal-requests",async(req,res)=>{
  try{
    const identity=await verifiedPiIdentity(req);
    const {data,error}=await supabase.rpc("get_my_withdrawal_requests",{p_pi_uid:identity.pi_uid,p_network:MAINNET});
    if(error)throw httpError(502,"Unable to load withdrawal requests.");
    return res.status(200).json({success:true,data:Array.isArray(data)?data:[]});
  }catch(error){
    const status=Number(error?.status)||500;
    return res.status(status).json({success:false,error:status>=500?"Unable to load withdrawal requests.":error.message});
  }
});

module.exports={financialGatewayRouter:router};
