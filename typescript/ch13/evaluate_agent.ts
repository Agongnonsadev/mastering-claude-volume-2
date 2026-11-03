// Chapter 13: several sessions of the agent per setting, its criteria, its cost and its duration.
//
// Run, from the typescript/ folder:  npx tsx ch13/evaluate_agent.ts --repetitions 3 --max-budget 2
// Settings:  sonnet (subagent for the messages), sonnet-direct-reading, haiku, opus
// Each session is kept in ch13/results/sessions.jsonl, for the review.

import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { writeCsv } from "../comptoir/csv.ts";
import { ROOT, multipleValues } from "../comptoir/launch.ts";
import { PyFloat, pythonJson } from "../comptoir/python.ts";
import { type AgentClient, Guard, type Settings, run, settings } from "../comptoir/restock_agent.ts";
import { fixed, round } from "../comptoir/rounding.ts";
import { Workshop } from "../comptoir/workshop.ts";
import { criteria } from "./criteria.ts";

const FOLDER = join(ROOT, "ch13", "results");
const SETTINGS: Record<string, Settings> = {
  sonnet: settings(),
  "sonnet-direct-reading": settings({ subagent: false }),
  haiku: settings({ model: "claude-haiku-5-5" }),
  opus: settings({ model: "claude-opus-5-5" }),
};
const FLOATS = ["cost_dollars", "of_which_subagent", "duration_s"]; // floats in Python

/** The non-empty lines of the summary (text.splitlines() and line.strip()). */
const summaryLines = (text: string): number => text.split(/\r\n|\r|\n/).filter((l) => l.trim()).length;

const { values: args } = parseArgs({
  args: multipleValues(["settings"]),
  options: {
    settings: { type: "string", multiple: true, default: ["sonnet", "sonnet-direct-reading", "haiku"] },
    repetitions: { type: "string", default: "3" },
    "max-budget": { type: "string", default: "2.0" }, // in dollars, for the whole evaluation
    output: { type: "string", default: "agent.csv" },
  },
});
const unknown = args.settings.filter((s) => !(s in SETTINGS));
if (unknown.length) throw new Error(`--settings: ${unknown.join(", ")}? Choices: ${Object.keys(SETTINGS).join(", ")}.`);
const maxBudget = Number(args["max-budget"]);

const client = new Anthropic() as unknown as AgentClient;
const rows: Record<string, string | number | boolean>[] = [];
let spent = 0;
mkdirSync(FOLDER, { recursive: true });
for (const name of args.settings) {
  for (let runNumber = 1; runNumber <= Number(args.repetitions); runNumber++) {
    if (spent >= maxBudget) {
      console.error(`Budget of $${maxBudget} reached: stopping.`); // SystemExit in Python: the CSV is not written
      process.exit(1);
    }
    const r = await run(client, new Workshop(), SETTINGS[name]!, new Guard({ budgetDollars: 0.6 }));
    spent += r.spent;
    const verdict = criteria(r.order);
    const row = {
      setting: name, run: runNumber, stop: r.stop ?? "", turns: r.turns, cost_dollars: round(r.spent, 5), of_which_subagent: round(r.subagentCost, 5),
      duration_s: round(r.durationS, 1), context_peak: r.contextPeak, tool_calls: r.tools.length, total_fcfa: r.order ? r.order.total_fcfa : "",
      summary_lines: summaryLines(r.text), criteria_met: Object.values(verdict).filter(Boolean).length, ...verdict,
    };
    rows.push(row);
    const asFloats = Object.fromEntries(FLOATS.map((k) => [k, new PyFloat(row[k as keyof typeof row] as number)]));
    appendFileSync(join(FOLDER, "sessions.jsonl"), pythonJson({ ...row, ...asFloats, order: r.order, summary: r.text, tools: r.tools, trace: r.trace.show() }) + "\n", "utf8");
    console.log(
      `${name.padEnd(24)} ${runNumber}  ${row.criteria_met}/${Object.keys(verdict).length}  ${String(r.turns).padStart(2)} turns  ` +
        `$${fixed(r.spent, 4)}  ${fixed(r.durationS, 1).padStart(5)} s  ${r.stop ?? ""}`,
    );
  }
}

const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
writeCsv(rows, columns, join(FOLDER, args.output), FLOATS);
const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
console.log(
  `\n${"setting".padEnd(24)} ${"sessions".padStart(8)} ${"criteria".padStart(9)} ${"avg cost".padStart(10)} ${"med. time".padStart(9)} ${"turns".padStart(6)} ${"max context".padStart(11)}`,
);
for (const name of args.settings) {
  const g = rows.filter((row) => row.setting === name);
  const values = (field: string): number[] => g.map((row) => Number(row[field]));
  console.log(
    `${name.padEnd(24)} ${String(g.length).padStart(8)} ${String(values("criteria_met").reduce((a, b) => a + b, 0)).padStart(4)}/${String(7 * g.length).padEnd(4)} ` +
      `$${fixed(mean(values("cost_dollars")), 4).padStart(9)} ${fixed(median(values("duration_s")), 1).padStart(8)}s ` +
      `${fixed(mean(values("turns")), 1).padStart(6)} ${String(Math.max(...values("context_peak"))).padStart(11)}`,
  );
}
console.log(`\nSpent: $${fixed(spent, 4)}`);
