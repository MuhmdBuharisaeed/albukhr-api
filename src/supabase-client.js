const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const MAINNET_URL = "https://ribpntyqdleytsyktdfb.supabase.co";
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required.");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");
if (SUPABASE_URL !== MAINNET_URL) throw new Error("ALBUKHR API is locked to the Mainnet Supabase project.");
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
module.exports = {supabase, SUPABASE_URL};
