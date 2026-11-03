// Chapter 12: the 30 messages, with and without the router, each in a new conversation.
//
// - direct: everything goes to the Comptoir of chapter 11 (Claude Sonnet 5.5, tools, base, one-hour cache);
// - routed: the router chooses the service, each step is traced.
//
// Run, from the typescript/ folder:  npx tsx ch12/routed_comptoir.ts --max-budget 1

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Budget } from "../comptoir/budget.ts";
import { makeClient } from "../comptoir/call.ts";
import { config } from "../comptoir/config.ts";
import { readCsv, writeCsv } from "../comptoir/csv.ts";
import { randomId } from "../comptoir/database.ts";
import { loadKnowledge } from "../comptoir/knowledge.ts";
import { ROOT, multipleValues } from "../comptoir/launch.ts";
import { ComptoirOrders } from "../comptoir/orders.ts";
import { sum } from "../comptoir/python.ts";
import { fixed, round } from "../comptoir/rounding.ts";
import { RoutedComptoir } from "../comptoir/routing.ts";
import { Shop } from "../comptoir/shop.ts";
import type { Trace } from "../comptoir/trace.ts";
import { loadMessages } from "./evaluate_router.ts";

const COLUMNS = ["mode", "id", "expected", "category", "calls", "cost_dollars", "duration_s", "requests_for_awa", "answer"] as const;
type Line = Record<(typeof COLUMNS)[number], string | number>;

const logLines = (): Record<string, unknown>[] =>
  existsSync(config.LOG) ? readFileSync(config.LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

function logCost(since: number): [number, number] {
  const calls = logLines().slice(since).filter((l) => "request" in l);
  return [sum(calls.map((l) => l.cost_dollars as number)), calls.length]; // Python's sum()
}

const { values: args } = parseArgs({
  args: multipleValues(["modes", "traces"]),
  options: {
    modes: { type: "string", multiple: true, default: ["direct", "routed"] },
    "max-budget": { type: "string", default: "1" },
    traces: { type: "string", multiple: true, default: ["godomey", "discomfort", "six-bissap"] },
  },
});
const unknown = args.modes.filter((m) => m !== "direct" && m !== "routed");
if (unknown.length) throw new Error(`--modes: ${unknown.join(", ")}? Choices: direct, routed.`);
const traces = args.traces.filter(Boolean);
const maxBudget = Number(args["max-budget"]);

const client = makeClient();
const base = loadKnowledge();
let lines: Line[] = [];
let spent = 0;
for (const mode of args.modes) {
  for (const m of loadMessages()) {
    if (spent >= maxBudget) {
      console.error(`Budget of $${maxBudget} reached: stopping.`); // SystemExit in Python: nothing is written
      process.exit(1);
    }
    const shop = new Shop(":memory:");
    const conversation = randomId();
    const before = logLines().length;
    const start = performance.now();
    let text: string;
    let category: string;
    let trace: Trace | null = null;
    if (mode === "direct") {
      const comptoir = new ComptoirOrders(client, shop, new Budget(":memory:"), conversation, { promptVersion: "v3", knowledge: base, cache: "1h" });
      text = (await comptoir.answer(m.message)).text;
      category = "—";
    } else {
      // The Comptoir of this chapter: Claude Sonnet 5.5 (chapter 17 replaced it with Haiku 5.5).
      const r = await new RoutedComptoir(client, shop, new Budget(":memory:"), conversation, base, { comptoirModel: config.MODEL }).answer(m.message);
      ({ text, category, trace } = r);
    }
    const duration = (performance.now() - start) / 1000;
    const [cost, calls] = logCost(before);
    spent += cost;
    lines.push({
      mode, id: m.id, expected: m.expected, category, calls, cost_dollars: round(cost, 6), duration_s: round(duration, 2),
      requests_for_awa: shop.requests().length, answer: text,
    });
    if (trace && traces.includes(m.id)) console.log(`\n--- ${m.id}: ${m.message}\n${text}\n${trace.show()}`);
  }
}

const output = join(ROOT, "ch12", "results", "comptoir.csv");
const fresh = lines;
if (existsSync(output)) {
  // Rerunning a single mode keeps the lines of the other.
  lines = [...(readCsv(output) as Line[]).filter((l) => !args.modes.includes(String(l.mode))), ...lines];
}
writeCsv(lines, [...COLUMNS], output, ["cost_dollars", "duration_s"]);

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
console.log(
  `\n${"mode".padEnd(9)} ${"expected category".padEnd(20)} ${"messages".padStart(8)} ${"calls".padStart(7)} ${"avg cost".padStart(11)} ${"median dur.".padStart(11)}`,
);
for (const mode of args.modes) {
  for (const expected of ["information", "order", "complaint", "other", null]) {
    const g = fresh.filter((l) => l.mode === mode && (expected === null || l.expected === expected));
    console.log(
      `${mode.padEnd(9)} ${(expected ?? "ALL").padEnd(20)} ${String(g.length).padStart(8)} ${String(g.reduce((s, l) => s + Number(l.calls), 0)).padStart(7)} ` +
        `${fixed(mean(g.map((l) => Number(l.cost_dollars))), 5).padStart(11)} ${fixed(median(g.map((l) => Number(l.duration_s))), 1).padStart(10)}s`,
    );
  }
}
console.log(`\nSpent: $${spent.toFixed(4)}; answers to review: ${output}`);
