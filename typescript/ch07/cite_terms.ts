// Chapter 7: answer a question about a supplier's terms, citing the passage.
//
// With --files-api, the PDF is sent once to the Files API, then designated by its ID, then deleted at
// the end.
//
// Run, from the typescript/ folder:
//     npx tsx ch07/cite_terms.ts "Within what time must I report a breakage?"
//     npx tsx ch07/cite_terms.ts --files-api "What is the minimum order?" "And the payment term?"

import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { config } from "../comptoir/config.ts";
import { cost } from "../comptoir/costs.ts";
import { fileBlock, pdfBlock } from "../comptoir/documents.ts";
import { PYTHON } from "../comptoir/launch.ts";
import { logCall } from "../comptoir/log.ts";

const PDF = join(PYTHON, "ch07", "documents", "supplier-terms.pdf");
const SYSTEM =
  "You answer the questions of Yao, from Délices d'Awa, about the terms of his suppliers. " +
  "You answer only from the document provided; if it does not contain the answer, say so.";

async function ask(client: Anthropic, document: Anthropic.ContentBlockParam, question: string): Promise<void> {
  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model: config.MODEL,
    max_tokens: 1500,
    system: SYSTEM,
    messages: [{ role: "user", content: [document, { type: "text", text: question }] }],
  };
  // Never a format: incompatible with citations.
  if (config.EFFORT) request.output_config = { effort: config.EFFORT as NonNullable<Anthropic.OutputConfig["effort"]> };
  const message = await client.messages.create(request);
  const price = cost(request.model, message.usage);
  logCall(message._request_id, request.model, price);
  let out = `\n${question}\n`;
  for (const block of message.content) {
    if (block.type !== "text") continue;
    out += block.text;
    for (const citation of block.citations ?? []) {
      if (citation.type === "page_location") out += ` [p. ${citation.start_page_number}: “${citation.cited_text.trim()}”]`;
    }
  }
  console.log(`${out}\n(${price})`);
}

const { values: args, positionals: questions } = parseArgs({ allowPositionals: true, options: { "files-api": { type: "boolean", default: false } } });
if (!questions.length) throw new Error("Ask at least one question.");
const client = new Anthropic();

if (!args["files-api"]) {
  const document = pdfBlock(PDF, "Supplier's terms of sale", true);
  for (const question of questions) await ask(client, document, question);
} else {
  const uploaded = await client.files.upload({ file: await toFile(readFileSync(PDF), basename(PDF), { type: "application/pdf" }) });
  console.log(`File sent: ${uploaded.id}`);
  try {
    const document = fileBlock(uploaded.id, "document", true);
    for (const question of questions) await ask(client, document, question);
  } finally {
    await client.files.delete(uploaded.id); // a file sent stays stored until it is deleted
    console.log("File deleted.");
  }
}
