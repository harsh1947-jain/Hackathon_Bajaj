// src/extractor/ocr.js
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "cross-fetch";
import dotenv from "dotenv";
import { Buffer } from "buffer";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- Helper: download image as buffer ---
async function downloadBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download image: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// --- Helper: detect mime type from magic bytes ---
function sniffMime(buffer) {
  const hex = buffer.slice(0, 4).toString("hex");
  if (hex.startsWith("89504e47")) return "image/png";
  if (hex.startsWith("ffd8ffe0") || hex.startsWith("ffd8ffe1")) return "image/jpeg";
  if (hex.startsWith("52494646")) return "image/webp";
  return "image/jpeg";
}

// --- Helper: clean ```json code fences ---
function cleanJsonFence(text) {
  let t = text.trim();
  if (t.startsWith("```")) {
    // remove first fence line
    t = t.replace(/^```(?:json)?/i, "").trim();
    // remove trailing ```
    if (t.endsWith("```")) {
      t = t.slice(0, -3).trim();
    }
  }
  return t;
}

// --- MAIN FUNCTION: returns EXACT HackRx schema ---
export async function extractBill(documentUrl) {
  let token_usage = {
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0
  };

  try {
    console.log("Downloading document:", documentUrl);
    const buffer = await downloadBuffer(documentUrl);
    const mimeType = sniffMime(buffer);
    const base64 = buffer.toString("base64");

    console.log("Image downloaded. Mime:", mimeType, "Base64 length:", base64.length);

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash"
    });

    const prompt = `
You are an OCR + invoice parser.

TASK:
- Read the provided BILL / INVOICE image.
- Extract ALL line items in the bill.
- Avoid missing any items.
- Avoid double-counting any items.

OUTPUT:
Return ONLY valid JSON (no markdown, no comments) in exactly this format:

{
  "pagewise_line_items": [
    {
      "page_no": "string",
      "page_type": "Bill Detail | Final Bill | Pharmacy",
      "bill_items": [
        {
          "item_name": "string",
          "item_amount": 0.0,
          "item_rate": 0.0,
          "item_quantity": 0.0
        }
      ]
    }
  ],
  "total_item_count": 0
}

Rules:
- "item_amount" = net amount for that line item after discounts.
- "item_rate" = per-unit rate exactly as in the bill.
- "item_quantity" = quantity exactly as in the bill.
- Use numeric values (floats) for amount, rate, quantity.
- "page_no" should start from "1" as string.
- "page_type" must be one of: "Bill Detail", "Final Bill", "Pharmacy".
- Ensure total_item_count = sum of items across all pages.
- Do NOT wrap in markdown fences.
`;

    console.log("Sending to Gemini 2.5 Flash...");

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType,
                data: base64
              }
            }
          ]
        }
      ]
    });

    const response = result.response;
    const usage = response.usageMetadata;
    if (usage) {
      token_usage = {
        total_tokens: usage.totalTokenCount || 0,
        input_tokens: usage.promptTokenCount || 0,
        output_tokens: usage.candidatesTokenCount || 0
      };
    }

    let rawText = response.text();
    console.log("Raw Gemini Output:", rawText);

    // Clean fences if any
    rawText = cleanJsonFence(rawText);

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      console.error("JSON parse error:", e);
      return {
        is_success: false,
        token_usage,
        data: {
          pagewise_line_items: [],
          total_item_count: 0
        },
        error: "Model returned invalid JSON"
      };
    }

    // --- Normalize into EXACT schema types ---

    let pages = Array.isArray(parsed.pagewise_line_items)
      ? parsed.pagewise_line_items
      : [];

    // Normalize all page & item fields
    pages = pages.map((page, idx) => {
      const page_no = page.page_no ? String(page.page_no) : String(idx + 1);
      const allowedTypes = ["Bill Detail", "Final Bill", "Pharmacy"];
      let page_type = typeof page.page_type === "string" ? page.page_type : "Bill Detail";
      if (!allowedTypes.includes(page_type)) page_type = "Bill Detail";

      const rawItems = Array.isArray(page.bill_items) ? page.bill_items : [];

      const bill_items = rawItems.map((item) => {
        const name = item.item_name || "";
        const amount = parseFloat(item.item_amount) || 0.0;
        const rate = parseFloat(item.item_rate) || 0.0;
        const qty = parseFloat(item.item_quantity) || 0.0;

        return {
          item_name: name,
          item_amount: amount,
          item_rate: rate,
          item_quantity: qty
        };
      });

      return {
        page_no,
        page_type,
        bill_items
      };
    });

    // total_item_count = sum of all line items
    const total_item_count =
      typeof parsed.total_item_count === "number"
        ? parsed.total_item_count
        : pages.reduce(
            (sum, p) => sum + (Array.isArray(p.bill_items) ? p.bill_items.length : 0),
            0
          );

    return {
      is_success: true,
      token_usage,
      data: {
        pagewise_line_items: pages,
        total_item_count
      }
    };
  } catch (err) {
    console.error("OCR ERROR:", err);
    return {
      is_success: false,
      token_usage,
      data: {
        pagewise_line_items: [],
        total_item_count: 0
      },
      error: err.message
    };
  }
}
