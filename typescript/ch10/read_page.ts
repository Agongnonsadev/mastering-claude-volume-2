// Chapter 10: read a specific page, bounding what it costs.
//
// Run, from the typescript/ folder:
//     npx tsx ch10/read_page.ts https://fr.wikipedia.org/wiki/Bissap "Summarize in three sentences."
//     npx tsx ch10/read_page.ts --max-read-tokens 2000 https://fr.wikipedia.org/wiki/Bissap "…"
// Page reading costs only its tokens; --max-read-tokens sets the ceiling.

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { config } from "../comptoir/config.ts";
import { call, sources, toolErrors, webFetch } from "../comptoir/server_tools.ts";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { "max-read-tokens": { type: "string", default: "8000" } },
});
const [url, instruction] = positionals;
if (!url || !instruction) throw new Error("Give the page's address, then the instruction.");
const maxReadTokens = Number(args["max-read-tokens"]);

const result = await call(new Anthropic(), {
  model: config.MODEL,
  max_tokens: 2000,
  tools: [webFetch(1, maxReadTokens)],
  // The address must appear in the message: Claude only reads URLs that have already appeared in the
  // conversation, never an address it would have written itself.
  messages: [{ role: "user", content: `${instruction}\n\nPage to read: ${url}` }],
});
console.log(result.text);
for (const source of sources(result.message)) console.log(`  [source: ${source.title}]`);
for (const error of toolErrors(result.message)) console.log(`  ⚠ ${error}`);
const usage = result.message.usage;
console.log(
  `\nInput ${usage.input_tokens} tokens (reading ceiling: ${maxReadTokens}), output ${usage.output_tokens}; ` +
    `cost $${result.cost.toFixed(4)}`,
);
