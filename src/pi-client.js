const PI_API_BASE = "https://api.minepi.com/v2";

function requirePiKey(){
  const key=String(process.env.PI_API_KEY||"").trim();
  if(!key) throw new Error("PI_API_KEY is not configured.");
  return key;
}

async function piRequest(path,options={}){
  const key=requirePiKey();
  const r=await fetch(`${PI_API_BASE}${path}`,{
    ...options,
    headers:{
      Authorization:`Key ${key}`,
      "Content-Type":"application/json",
      ...(options.headers||{})
    }
  });
  const t=await r.text();
  let d=null;
  try{d=t?JSON.parse(t):null}catch{d=t||null}
  if(!r.ok){
    const e=new Error(d?.message||d?.error||`Pi API request failed with HTTP ${r.status}.`);
    e.status=r.status;
    e.data=d;
    throw e;
  }
  return d;
}

async function getPayment(id){
  return piRequest(`/payments/${encodeURIComponent(id)}`);
}

async function approvePayment(id){
  return piRequest(`/payments/${encodeURIComponent(id)}/approve`,{method:"POST",body:"{}"});
}

async function completePayment(id,txid){
  if(!txid) throw new Error("Pi transaction ID is required for completion.");
  return piRequest(`/payments/${encodeURIComponent(id)}/complete`,{
    method:"POST",
    body:JSON.stringify({txid:String(txid).trim()})
  });
}

async function getPioneer(token){
  if(!token) throw new Error("Pi access token is required.");
  const r=await fetch(`${PI_API_BASE}/me`,{headers:{Authorization:`Bearer ${token}`}});
  const d=await r.json().catch(()=>null);
  if(!r.ok||!d?.uid) throw new Error("Pi authentication could not be verified.");
  return d;
}

function verifyPaymentMetadata(payment,metadata){
  const a=Number(payment?.amount),b=Number(metadata?.amount);
  if(!Number.isFinite(a)||!Number.isFinite(b)||a!==b) throw new Error("Pi payment amount does not match the requested amount.");
  if(metadata?.network!=="mainnet"||payment?.metadata?.network!=="mainnet") throw new Error("Only Mainnet payments are accepted.");
  if(payment?.metadata?.action!=="add_liquidity") throw new Error("Unsupported Pi payment action.");
  if(String(payment?.metadata?.project_code||"")!==String(metadata?.project_code||"")) throw new Error("Pi payment project does not match.");
  if(Number(payment?.metadata?.duration)!==Number(metadata?.duration)) throw new Error("Pi payment duration does not match the requested duration.");
}

module.exports={getPayment,approvePayment,completePayment,getPioneer,verifyPaymentMetadata};
