const express = require("express");
const cors = require("cors");
const axios = require("axios");

const { createClient } =
require("@supabase/supabase-js");

const StellarSdk =
require("stellar-sdk");

const app = express();

const IS_MAINNET = true;

app.use(cors());
app.use(express.json());

console.log("================================");
console.log("ALBUKHR MAINNET PAYMENT SERVER");
console.log("Network:", IS_MAINNET ? "MAINNET" : "TESTNET");
console.log("================================");

const supabase =
createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const server =
new StellarSdk.Horizon.Server(
  "https://api.mainnet.minepi.com"
);

app.get("/", (req, res) => {
  res.status(200).json({
    status: "OK"
  });
});

/* ===================================
   APPROVE PAYMENT
=================================== */
app.post("/approve", async (req, res) => {

  try {

    const paymentId = req.body.paymentId;

    console.log("APPROVING PAYMENT:", paymentId);

    console.log(
      "PI API KEY EXISTS:",
      !!process.env.PI_API_KEY
    );

    const response = await axios.post(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      {},
      {
        headers: {
          Authorization: `Key ${process.env.PI_API_KEY}`
        }
      }
    );

    console.log("APPROVED SUCCESS");

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {

    console.log(
      "APPROVE ERROR:",
      error.response?.data || error.message
    );

    res.status(500).json({
      success: false,
      error:
        error.response?.data ||
        error.message
    });

  }

});

/* ===================================
   COMPLETE PAYMENT
=================================== */
app.post("/complete", async (req, res) => {

  try {

    const { paymentId, txid } = req.body;

    console.log("COMPLETING PAYMENT:", paymentId);

    const response = await axios.post(
      `https://api.minepi.com/v2/payments/${paymentId}/complete`,
      { txid },
      {
        headers: {
          Authorization: `Key ${process.env.PI_API_KEY}`
        }
      }
    );

    console.log("COMPLETED SUCCESS");

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {

    console.log(
      "COMPLETE ERROR:",
      error.response?.data || error.message
    );

    res.status(500).json({
      success: false,
      error:
        error.response?.data ||
        error.message
    });

  }

});

/* ===================================
   GET WITHDRAW REQUEST
=================================== */
app.post("/withdraw", async (req, res) => {

  try {

    const { requestId } = req.body;

    if(!requestId){
      return res.status(400).json({
        error: "Missing requestId"
      });
    }

    const { data, error } =
      await supabase
        .from("withdraw_requests")
        .select("*")
        .eq("id", requestId)
        .single();

    if(error || !data){
      return res.status(404).json({
        error: "Request not found"
      });
    }

    if(data.status !== "approved"){
      return res.status(400).json({
        error: "Request not approved"
      });
    }

    return res.json({
      success: true,
      request: data
    });

  } catch(err){

    console.log(err);

    return res.status(500).json({
      error: err.message
    });

  }

});

app.get("/supabase-status", async (req,res)=>{

  try{

    const { data, error } =
      await supabase
        .from("withdraw_requests")
        .select("*")
        .limit(1);

    if(error){
      return res.status(500).json({
        error:error.message
      });
    }

    res.json({
      success:true,
      rows:data
    });

  }catch(err){

    res.status(500).json({
      error:err.message
    });

  }

});

app.get("/mainnet-status", async (req,res)=>{

  try{

    const account =
      await server.loadAccount(
        "GCUL57JUBQNCF4YGEQFP33NZMWNCXWJMIVB66SJWHBW7AS6ZDQ4JL26V"
      );

    res.json({
      success:true,
      sequence:account.sequence
    });

  }catch(error){

    res.status(500).json({
      success:false,
      error:error.message
    });

  }

});

app.get("/wallet-status", (req,res)=>{

  try {

    const kp =
      StellarSdk.Keypair.fromSecret(
        process.env.WALLET_PRIVATE_SEED
      );

    res.json({
      success: true,
      publicKey: kp.publicKey()
    });

  } catch(err){

    res.status(500).json({
      success: false,
      error: err.message
    });

  }

});

/* ===================================
   PAY WITHDRAW
=================================== */
app.post("/pay-withdraw", async (req, res) => {

  try {

    const { requestId } = req.body;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: "Missing requestId"
      });
    }

    /* Load Withdraw Request */
    const { data, error } = await supabase
      .from("withdraw_requests")
      .select("*")
      .eq("id", requestId)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: "Request not found"
      });
    }

    console.log("REQUEST ID:", requestId);
console.log("REQUEST STATUS:", data?.status);

    if (data.status !== "approved") {
      return res.status(400).json({
        success: false,
        error: "Request must be approved first"
      });
    }

    /* Load Admin Wallet */
    const sourceKeypair =
      StellarSdk.Keypair.fromSecret(
        process.env.WALLET_PRIVATE_SEED
      );

    const sourceAccount =
      await server.loadAccount(
        sourceKeypair.publicKey()
      );

    /* Create Payment Transaction */
    const baseFee =
  await server.fetchBaseFee();

console.log(
  "NETWORK BASE FEE:",
  baseFee
);

const transaction =
  new StellarSdk.TransactionBuilder(
    sourceAccount,
    {
      fee: baseFee.toString(),
      networkPassphrase: "Pi Network"
    }
  )
      .addOperation(
        StellarSdk.Operation.payment({
          destination: data.wallet,
          asset: StellarSdk.Asset.native(),
          amount: Number(data.amount).toFixed(7)
        })
      )
      .setTimeout(180)
      .build();

    /* Sign */
    transaction.sign(sourceKeypair);

    /* Submit */
    const result =
      await server.submitTransaction(
        transaction
      );

    const txHash = result.hash;

    /* Update Withdraw Request */
    await supabase
      .from("withdraw_requests")
      .update({
        status: "paid",
        txid: txHash,
        processed_at:
          new Date().toISOString()
      })
      .eq("id", requestId);

    /* Update Transactions Table */
    await supabase
      .from("transactions")
      .update({
        status: "paid",
        txid: txHash,
        processed_at:
          new Date().toISOString()
      })
      .eq("userid", data.userid)
      .eq("wallet", data.wallet)
      .eq("status", "approved");

    return res.json({
      success: true,
      txid: txHash
    });

  } catch(error){

  console.log(
    "RESULT CODES:",
    JSON.stringify(
      error.response?.data?.extras?.result_codes,
      null,
      2
    )
  );

  console.log(
    "FULL ERROR:",
    JSON.stringify(
      error.response?.data,
      null,
      2
    )
  );

  return res.status(500).json({
    success:false,
    error:
      JSON.stringify(
        error.response?.data?.extras?.result_codes
      )
  });

  }

});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(
    `ALBUKHR PAYMENT SERVER RUNNING ON PORT ${PORT}`
  );
});
