// src/server.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { extractBillData } from "./extractor/index.js";

dotenv.config();

const app = express();
app.use(bodyParser.json());


app.set("json spaces", 2);
// Health check
app.get("/", (req, res) => {
  res.send("HackRx Bill Extraction API is running");
});

// Main endpoint as per problem spec
app.post("/extract-bill-data", async (req, res) => {
  try {
    const { document } = req.body;

    if (!document) {
      return res.status(400).json({
        is_success: false,
        token_usage: {
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0
        },
        data: null,
        error: "Missing 'document' URL in request body"
      });
    }

    const result = await extractBillData(document);

    // Always follow the schema exactly
    return res.status(200).json(result);

  } catch (err) {
    console.error("Error in /extract-bill-data:", err);
    return res.status(500).json({
      is_success: false,
      token_usage: {
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0
      },
      data: null,
      error: "Internal server error"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bill extraction API running on port ${PORT}`);
});
