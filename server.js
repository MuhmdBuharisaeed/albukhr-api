const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

app.use(cors());
app.use(express.json());

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

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(
    `ALBUKHR PAYMENT SERVER RUNNING ON PORT ${PORT}`
  );
});
