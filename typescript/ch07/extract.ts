// Chapter 7: extract the data of a purchase order (photo) or an invoice (PDF).
//
// The sample documents are those of the Python version (python/ch07/documents/), made once by
// python/ch07/make_samples.py.
// Run, from the typescript/ folder:
//     npx tsx ch07/extract.ts ../python/ch07/documents/order-01.jpg
//     npx tsx ch07/extract.ts ../python/ch07/documents/order-01.jpg --max-side 1000
//     npx tsx ch07/extract.ts ../python/ch07/documents/invoice-01.pdf --estimate      (free: counts the tokens)

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { documentBlock } from "../comptoir/documents.ts";
import { type Invoice, PurchaseOrder, checkInvoice, checkOrder, extract, extractionRequest, schemaFor } from "../comptoir/extraction.ts";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "max-side": { type: "string" }, // shrink the image before sending it (in pixels)
    estimate: { type: "boolean", default: false }, // count the input tokens, without extracting
  },
});
const document = positionals[0];
if (!document) throw new Error("Give the document to read.");

const client = new Anthropic();
const schema = schemaFor(document);
const blocks = [await documentBlock(document, args["max-side"] ? Number(args["max-side"]) : null)];

if (args.estimate) {
  const { model, system, messages, output_config } = extractionRequest(blocks, schema);
  const count = await client.messages.countTokens({ model, system, messages, output_config });
  console.log(`Input tokens: ${count.input_tokens}`);
} else {
  const result = await extract(client, blocks, schema);
  console.log(`Cost: ${result.cost}  (request ${result.requestId})`);
  if (result.error || !result.data) {
    console.log(`Failure: ${result.error}`);
  } else {
    console.log(JSON.stringify(result.data, null, 2));
    const check = schema === PurchaseOrder ? checkOrder(result.data as PurchaseOrder) : checkInvoice(result.data as Invoice);
    console.log(`\nAmount calculated by the code: ${check.computedAmount}`);
    for (const anomaly of check.anomalies) console.log(`  ⚠ ${anomaly}`);
    console.log(check.toReview ? "To be reviewed by a human." : "No anomaly: to be approved by a human.");
  }
}
