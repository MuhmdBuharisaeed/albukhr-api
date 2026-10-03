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
  try{d=t?
