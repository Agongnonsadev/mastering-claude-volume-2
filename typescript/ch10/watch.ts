// Chapter 10: a current-events question, with web search and its sources.
//
// Run, from the typescript/ folder:
//     npx tsx ch10/watch.ts "Which public holidays fall in Benin in November and December 2026?"
//     npx tsx ch10/watch.ts --filtering "…"          (dynamic filtering of the results)
// Cost: $10 per 1,000 searches (at most --max-searches), plus the tokens of the results.

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { config } from "../comptoir/config.ts";
import { call, sources, toolErrors, webSearch } from "../comptoir/server_tools.ts";

const SYSTEM =
  "You help Yao, at Délices d'Awa in Cotonou, plan the schedule. Answer in English, briefly, " +
  "and base each piece of information on a source you found. If the sources contradict each other or are missing, say so.";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "max-searches": { type: "string", default: "3" },
    filtering: { type: "boolean", default: false }, // dynamic filtering (web_search_20260209)
  },
});
const question = positionals[0];
if (!question) throw new Error("Give the question.");

const result = await call(new Anthropic(), {
  model: config.MODEL,
  max_tokens: 3000,
  system: SYSTEM,
  tools: [webSearch(Number(args["max-searches"]), null, args.filtering)],
  messages: [{ role: "user", content: question }],
});
console.log(result.text);
console.log("\nSources:");
for (const source of sources(result.message)) console.log(`  - ${source.title} — ${source.source}`);
for (const error of toolErrors(result.message)) console.log(`  ⚠ ${error}`);
const usage = result.message.usage;
console.log(
  `\n${result.searches} search(es), ${result.calls} call(s), ${result.resumptions} resumption(s); ` +
    `input ${usage.input_tokens} tokens, output ${usage.output_tokens}; cost $${result.cost.toFixed(4)}`,
);
