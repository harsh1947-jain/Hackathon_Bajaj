// src/extractor/index.js
import { extractBill } from "./ocr.js";

// This function returns EXACTLY the response object
// required by the /extract-bill-data endpoint.
export async function extractBillData(documentUrl) {
  return await extractBill(documentUrl);
}
