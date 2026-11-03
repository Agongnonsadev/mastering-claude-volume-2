// Chapter 12: the complaints chain, on the six test complaints, with their trace.
//
// Run, from the typescript/ folder:  npx tsx ch12/complaints.ts
// Compare two drafting efforts:      npx tsx ch12/complaints.ts --effort default --repetitions 2
//                                    npx tsx ch12/complaints.ts --effort low --repetitions 2

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { type ComplaintResult, DRAFTING_EFFORT, handle } from "../comptoir/complaints.ts";
import { randomId } from "../comptoir/database.ts";
import { multipleValues } from "../comptoir/launch.ts";
import { repr } from "../comptoir/python.ts";
import { fixed } from "../comptoir/rounding.ts";
import { Shop } from "../comptoir/shop.ts";
import { Trace } from "../comptoir/trace.ts";
import { loadMessages } from "./evaluate_router.ts";

const EFFORTS = ["default", "low", "medium", "high"];

const { values: args } = parseArgs({
  args: multipleValues(["only"]),
  options: {
    only: { type: "string", multiple: true },
    effort: { type: "string" }, // drafting effort; without this option, the module's; “default”: the model's
    repetitions: { type: "string", default: "1" },
  },
});
if (args.effort !== undefined && !EFFORTS.includes(args.effort)) throw new Error(`--effort: ${EFFORTS.join(", ")}.`);
const effort = args.effort === undefined ? DRAFTING_EFFORT : args.effort === "default" ? null : (args.effort as "low" | "medium" | "high");
const only = (args.only ?? []).filter(Boolean);

const client = new Anthropic();
const shop = new Shop(":memory:");
const traces: Trace[] = [];
const results: ComplaintResult[] = [];
const chosen = loadMessages().filter((m) => m.expected === "complaint");
for (let r = 0; r < Number(args.repetitions); r++) {
  for (const m of chosen.filter((m) => !only.length || only.includes(m.id))) {
    const trace = new Trace();
    const result = await handle(client, m.message, shop, randomId(), { trace, effort });
    traces.push(trace);
    results.push(result);
    console.log(`\n=== ${m.id} ===\nCustomer : ${m.message}\nComptoir : ${result.reply}`);
    console.log(`Facts    : ${repr(result.facts)}`);
    console.log(
      `To ask: ${result.missing.length ? repr(result.missing) : "nothing"}; versions: ${result.attempts}; ` +
        `fallback text: ${result.fallback ? "yes" : "no"}`,
    );
    const rejected = Math.min(result.versions.length, result.critiques.length);
    for (let i = 0; i < rejected; i++) {
      console.log(`Version ${i + 1}, rejected: ${result.versions[i]}`);
      console.log(`  Critique: ${result.critiques[i]}`);
    }
    console.log(trace.show());
  }
}
const cutOff = results.flatMap((r) => r.critiques).filter((c) => c.startsWith("answer stopped")).length;
const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
console.log(
  `\nDrafting effort: ${effort || "model default"}; complaints: ${results.length}; ` +
    `compliant at the 1st version: ${results.filter((r) => r.attempts === 1 && !r.fallback).length}; ` +
    `cut-off drafts: ${cutOff}; fallback texts: ${results.filter((r) => r.fallback).length}`,
);
console.log(
  `Average cost: $${fixed(mean(traces.map((t) => t.cost)), 5)}; median duration: ` +
    `${fixed(median(traces.map((t) => t.durationMs)) / 1000, 1)} s; total cost: $${fixed(traces.reduce((s, t) => s + t.cost, 0), 4)}; ` +
    `requests recorded for Awa: ${shop.requests().length}`,
);
