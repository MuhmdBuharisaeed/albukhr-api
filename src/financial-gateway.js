"use strict";

const express = require("express");
const { supabase } = require("./supabase-client");
const {
  getPayment,
  approvePayment,
  completePayment,
  getPioneer,
  verifyPaymentMetadata
} = require("./pi-client");

const router = express.Router();
const MAINNET = "mainnet";

function httpError(status,message){const e=new Error(message);e.status=status;return e;}
function requireBearer(req){
  const value=String(req.headers.authorization||"").trim();
  if(!value.toLowerCase().startsWith("bearer ")) throw httpError(401,"Pi authentication token is required.");
  const token=value.slice(7).trim();
  if(!token) throw httpError(401,"Pi authentication token is required.");
  return token;
}
function body(req){return req.body&&typeof req.body==="object"&&!Array.isArray(req.body)?req.body:{};}
function clean(value,field,max=200){const v=String(value||"").trim();if(!v||v.length>max)throw httpError(400,`${field} is invalid.`);return v;}
function positiveAmount(value){const n=Number(value);if(!Number.isFinite(n)||n<=0||n>1000000000)throw httpError(400,"amount is invalid.");return n;}
function duration(value){const n=Number(value);if(!Number.isInteger(n)||![30,60,90,180,365,430].includes(n))throw httpError(400,"duration is invalid.");return n;}

async function verifiedPiIdentity(req){
  const token=requireBearer(req);
  const pioneer=await getPioneer(token);
  const piUid=String(pioneer.uid||"").trim();
  if(!piUid)throw httpError(401,"Pi identity could not be verified.");
  return {pi_uid:piUid,token};
}

async function getProject(projectCode,{requireActive=false}={}){
  const {data,error}=await supabase.from("projects")
    .select("id,project_code,project_type,status,core_slot,network")
    .eq("project_code",projectCode).eq("network",MAINNET).maybeSingle();
  if(error)throw httpError(502,"ALBUKHR project lookup failed.");
  if(!data)throw httpError(404,"Mainnet project was not found.");
  if(String(data.project_type).toLowerCase()!=="core")throw httpError(403,"Only Mainnet Core Projects can receive core liquidity.");
  if(!Number.isInteger(Number(data.core_slot))||Number(data.core_slot)<1||Number(data.core_slot)>7)throw httpError(403,"Project Core Slot is invalid.");
  const status=String(data.status||"").toLowerCase();
  if(requireActive&&status!=="active")throw httpError(403,"Project is not ACTIVE for investment.");
  if(!requireActive&&!['approved','active'].includes(status))throw httpError(403,"Project is not eligible for liquidity settlement.");
  return data;
}

async function getTreasury(projectId){
  const {data,error}=await supabase.from("project_treasury")
    .select("treasury_wallet,required_liquidity,status,network")
    .eq("project_id",projectId).maybeSingle();
  if(error)throw httpError(502,"ALBUKHR treasury lookup failed.");
  if(!data)throw httpError(409,"Project treasury is not configured.");
  if(!data.treasury_wallet||data.required_liquidity==null)throw httpError(409,"Project treasury is not fully configured.");
  if(data.network!==MAINNET)throw httpError(403,"Only Mainnet treasury is accepted.");
  if(!['active','locked'].includes(String(data.status||'').toLowerCase()))throw httpError(409,"Project treasury is not active.");
  return data;
}

function paymentRecipient(payment){return String(payment?.to_address||payment?.recipient_address||payment?.recipient?.address||payment?.transaction?.to_address||"").trim();}
function paymentSenderUid(payment){return String(payment?.from_uid||payment?.sender_uid||payment?.sender?.uid||"").trim();}
function paymentStatus(payment){return String(payment?.status||payment?.transaction?.status||"").trim().toLowerCase();}

function assertSender(payment,piUid){const sender=paymentSenderUid(payment);if(sender&&sender!==piUid)throw httpError(403,"Pi payment sender does not match the authenticated Pi account.");}

async function verifyPaymentForProject(payment,{project,treasury,piUid,amount,durationDays}){
  const status=paymentStatus(payment);
  if(!['created','pending','approved','completed'].includes(status))throw httpError(409,"Pi payment is not in a valid processing state.");
  assertSender(payment,piUid);
  verifyPaymentMetadata(payment,{amount,network:MAINNET,project_code:project.project_code,duration:durationDays});
  const recipient=paymentRecipient(payment);
  if(recipient&&recipient!==treasury.treasury_wallet)throw httpError(403,"Pi payment recipient does not match the project treasury wallet.");
  return {status,recipient};
}

router.post("/api/pi-payment-approve",async(req,res)=>{
  try{
    const identity=await verifiedPiIdentity(req);
    const b=body(req);
    const projectCode=clean(b.project_code,"project_code",100);
    const paymentId=clean(b.payment_id,"payment_id",200);
    const amount=positiveAmount(b.amount);
    const durationDays=duration(b.duration);
    const project=await getProject(projectCode,{requireActive:true});
    const treasury=await getTreasury(project.id);
    const payment=await getPayment(paymentId);
    await verifyPaymentForProject(payment,{project,treasury,piUid:identity.pi_uid,amount,durationDays});
    const result=await approvePayment(paymentId);
    return res.status(200).json({success:true,data:{payment_id:paymentId,approval:result}});
  }catch(error){
    const status=Number(error?.status)||500;
    if(status>=500)console.error("[ALBUKHR API] Payment approval error",error);
    return res.status(status).json({success:false,error:status>=500?"Payment approval failed.":error.message});
  }
});

router.post("/api/pi-payment-complete",async(req,res)=>{
  try{
    const identity=await verifiedPiIdentity(req);
    const b=body(req);
    const projectCode=clean(b.project_code,"project_code",100);
    const paymentId=clean(b.payment_id,"payment_id",200);
    const txid=clean(b.txid,"txid",300);
    const amount=positiveAmount(b.amount);
    const durationDays=duration(b.duration);
    const project=await getProject(projectCode,{requireActive:true});
    const treasury=await getTreasury(project.id);
    const before=await getPayment(paymentId);
    await verifyPaymentForProject(before,{project,treasury,piUid:identity.pi_uid,amount,durationDays});

    const completion=await completePayment(paymentId,txid);
    const after=await getPayment(paymentId);
    const finalStatus=paymentStatus(after);
    if(finalStatus!=="completed")throw httpError(409,"Pi payment was not confirmed as completed.");
    assertSender(after,identity.pi_uid);
    verifyPaymentMetadata(after,{amount,network:MAINNET,project_code:project.project_code,duration:durationDays});
    const recipient=paymentRecipient(after);
    if(!recipient||recipient!==treasury.treasury_wallet)throw httpError(403,"Completed Pi payment recipient does not match the project treasury wallet.");

    const transactionId=String(after?.transaction?.txid||after?.transaction?.id||txid).trim();
    const {data,error}=await supabase.rpc("create_stake_from_completed_payment",{
      p_project_id:project.id,
      p_payment_id:paymentId,
      p_payer_pi_uid:identity.pi_uid,
      p_amount:amount,
      p_recipient_wallet:recipient,
      p_pi_status:finalStatus,
      p_verification_reference:transactionId,
      p_request_id:null,
      p_duration_days:durationDays,
      p_metadata:{source:"albukhr-api",project_code:projectCode,duration_days:durationDays,transaction_id:transactionId}
    });
    if(error){
      console.error("[ALBUKHR API] Stake settlement RPC failed",{code:error.code,message:error.message});
      throw httpError(502,"ALBUKHR stake settlement failed.");
    }
    return res.status(200).json({success:true,data:{completion,stake:data}});
  }catch(error){
    const status=Number(error?.status)||500;
    if(status>=500)console.error("[ALBUKHR API] Payment completion error",error);
    return res.status(status).json({success:false,error:status>=500?"Payment completion failed.":error.message});
  }
});

router.get("/api/my-stakes",async(req,res)=>{
  try{
    const identity=await verifiedPiIdentity(req);
    const network=String(req.query.network||MAINNET).toLowerCase();
    if(network!==MAINNET)throw httpError(403,"Only Mainnet stakes are available.");
    const {data,error}=await supabase.rpc("get_my_stakes",{p_pi_uid:identity.pi_uid,p_network:MAINNET});
    if(error)throw httpError(502,"Unable to load Mainnet stakes.");
    const projectCode=String(req.query.project_code||"").trim();
    const rows=projectCode?(data||[]).filter(x=>String(x.project_code||"")===projectCode):(data||[]);
    return res.status(200).json({success:true,data:rows});
  }catch(error){
    const status=Number(error?.status)||500;
    return res.status(status).json({success:false,error:status>=500?"Unable to load stakes.":error.message});
  }
});

module.exports={financialGatewayRouter:router};
