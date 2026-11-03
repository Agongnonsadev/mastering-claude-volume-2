// Chapter 11: 20 questions, three ways of giving Claude the documents, one grid.
//
// - context: the whole base in the request, read from the cache;
// - rag: the 5 chunks found by BM25;
// - rag-reranked: the first 10 of BM25, reranked by Claude Haiku 5.5, which keeps 3.
//
// Run, from the typescript/ folder:
//     npx tsx ch11/evaluate_doc_assistant.ts --max-budget 0.8
//     npx tsx ch11/evaluate_doc_assistant.ts --modes context --max-budget 0.3
//     npx tsx ch11/evaluate_doc_assistant.ts --modes context --model claude-haiku-5-5 --output trials-haiku.csv

import Anthropic from "@anthropic-ai/sdk";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { writeCsv } from "../comptoir/csv.ts";
import { MAX_TOKENS, answer, loadPrompt, scoreDocAnswer } from "../comptoir/doc_assistant.ts";
import { loadKnowledge } from "../comptoir/knowledge.ts";
import { multipleValues } from "../comptoir/launch.ts";
import { rerank } from "../comptoir/retrieval.ts";
import { round } from "../comptoir/rounding.ts";
import { RESULTS, bm25Index, loadQuestions } from "./shared.ts";

const MODES = ["context", "rag", "rag-reranked"];

/** A line of results/trials.csv: the same columns as in the Python version. */
interface Trial {
  mode: string;
  case: string;
  passed: boolean;
  reasons: string;
  to_review: string;
  answer: string;
  sources: string;
  chunks_sent: number;
  input_tokens: number;
  cache_written: number;
  cache_read: number;
  output_tokens: number;
  cost_dollars: number;
  reranking_cost: number;
  latency_s: number;
}

const COLUMNS: (keyof Trial)[] = [
  "mode", "case", "passed", "reasons", "to_review", "answer", "sources", "chunks_sent", "input_tokens",
  "cache_written", "cache_read", "output_tokens", "cost_dollars", "reranking_cost", "latency_s",
];

const { values: args } = parseArgs({
  args: multipleValues(["modes"]),
  options: {
    modes: { type: "string", multiple: true, default: MODES },
    "max-budget": { type: "string", default: "0.8" },
    model: { type: "string" }, //                       the model that answers (by default, the Comptoir's)
    output: { type: "string", default: "trials.csv" },
    "no-thinking": { type: "boolean", default: false }, // Claude Haiku 5.5: answer without thinking
    "max-tokens": { type: "string", default: String(MAX_TOKENS) },
    prompt: { type: "string", default: "v1" }, //         the version of the document assistant's prompt
    "no-citations": { type: "boolean", default: false }, // without citations: the sources are not graded
  },
});
const unknown = args.modes.filter((m) => !MODES.includes(m));
if (unknown.length) throw new Error(`--modes: ${unknown.join(", ")}? Choices: ${MODES.join(", ")}.`);
const maxBudget = Number(args["max-budget"]);

const client = new Anthropic();
const base = loadKnowledge();
const prompt = loadPrompt(args.prompt);
// Measured (ch11/measure_retrieval.ts): on this base, contextual BM25 does no better.
const index = bm25Index(false);
const trials: Trial[] = [];
let spent = 0;
for (const mode of args.modes) {
  for (const c of loadQuestions()) {
    if (spent >= maxBudget) {
      console.log(`Budget of $${maxBudget} reached: stopping.`);
      break;
    }
    let retrievalCost = 0;
    let chunks = base;
    let cache = true;
    if (mode === "rag") {
      chunks = index.search(c.question, 5).map(([m]) => m);
      cache = false;
    } else if (mode === "rag-reranked") {
      const candidates = index.search(c.question, 10).map(([m]) => m);
      [chunks, retrievalCost] = await rerank(client, c.question, candidates, 3);
      cache = false;
    }
    const result = await answer(client, c.question, chunks, {
      prompt,
      cache,
      mode,
      model: args.model ?? null,
      noThinking: args["no-thinking"],
      maxTokens: Number(args["max-tokens"]),
      withCitations: !args["no-citations"],
    });
    const reasons = scoreDocAnswer(c, result, !args["no-citations"]);
    spent += result.cost.dollars + retrievalCost;
    trials.push({
      mode,
      case: c.id,
      passed: !reasons.length,
      reasons: reasons.join("; "),
      to_review: c.to_review,
      answer: result.text,
      sources: result.sources.join(" "),
      chunks_sent: chunks.length,
      input_tokens: result.cost.input,
      cache_written: result.cost.cacheWrite,
      cache_read: result.cost.cacheRead,
      output_tokens: result.cost.output,
      cost_dollars: result.cost.dollars,
      reranking_cost: round(retrievalCost, 6),
      latency_s: result.latencyS,
    });
  }
}

const output = join(RESULTS, args.output);
writeCsv(trials, COLUMNS, output, ["cost_dollars", "reranking_cost", "latency_s"]);

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
console.log(
  `${"mode".padEnd(14)} ${"success".padStart(9)} ${"cost/answer".padStart(13)} ${"total cost".padStart(11)} ` +
    `${"median lat.".padStart(13)} ${"avg input".padStart(12)}`,
);
for (const mode of new Set(trials.map((t) => t.mode))) {
  const g = trials.filter((t) => t.mode === mode);
  const costs = g.map((t) => t.cost_dollars + t.reranking_cost);
  console.log(
    `${mode.padEnd(14)} ${String(g.filter((t) => t.passed).length).padStart(5)}/${String(g.length).padEnd(3)} ` +
      `${mean(costs).toFixed(5).padStart(13)} ${costs.reduce((a, b) => a + b, 0).toFixed(4).padStart(11)} ` +
      `${median(g.map((t) => t.latency_s)).toFixed(1).padStart(12)}s ` +
      `${String(round(mean(g.map((t) => t.input_tokens + t.cache_written + t.cache_read)))).padStart(12)}`,
  );
}
console.log("\nFailures according to the code:");
for (const t of trials) if (!t.passed) console.log(`  ${t.mode.padEnd(13)} ${t.case.padEnd(16)} ${t.reasons}`);
console.log(`\nSpent on the answers: $${spent.toFixed(4)} (reranking included). Answers to review: ${output}`);
