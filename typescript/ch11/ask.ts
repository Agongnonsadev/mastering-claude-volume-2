// Chapter 11: asking Awa's documents a question, and seeing where the answer comes from.
//
// Run, from the typescript/ folder:
//     npx tsx ch11/ask.ts "Do you deliver on Sundays?"
//     npx tsx ch11/ask.ts --mode rag "Do you deliver to Godomey?"

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { answer } from "../comptoir/doc_assistant.ts";
import { loadKnowledge } from "../comptoir/knowledge.ts";
import { bm25Index } from "./shared.ts";

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { mode: { type: "string", default: "context" } } });
const question = positionals[0];
if (!question) throw new Error("Give the question.");
if (args.mode !== "context" && args.mode !== "rag") throw new Error("--mode: context or rag.");

// context: the whole base, cached; rag: the 5 chunks found by the retrieval, without cache.
const [chunks, cache] =
  args.mode === "context" ? [loadKnowledge(), true] : [bm25Index(false).search(question, 5).map(([c]) => c), false];

const result = await answer(new Anthropic(), question, chunks, { cache, mode: args.mode });
console.log(result.text, "\n");
result.sources.forEach((source, i) => {
  const title = result.citations.find((c) => c.source === source)!.title;
  console.log(`[${i + 1}] ${title}  (${source})`);
});
if (!result.sources.length) console.log("(no source cited)");
const c = result.cost;
console.log(
  `\n[${c.input} input tokens, ${c.cacheWrite} written to the cache, ${c.cacheRead} read from the cache, ` +
    `${c.output} output; ${c}; ${result.latencyS} s]`,
);
