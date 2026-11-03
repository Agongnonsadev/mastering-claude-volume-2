// Chapter 12: does the router classify well? 30 messages, several settings, several passes.
//
// For each setting: the success, the missed complaints (the only forbidden failure), the cost and the
// duration per message. The vote of three is computed from the three passes, without an extra call. The 30
// messages are those of the Python version (python/ch12/messages.json).
//
// Run, from the typescript/ folder:  npx tsx ch12/evaluate_router.ts --repetitions 3 --max-budget 0.5

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { writeCsv } from "../comptoir/csv.ts";
import { PYTHON, ROOT, isMain, multipleValues } from "../comptoir/launch.ts";
import { type ClassifyOptions, type Decision, RoutingImpossible, byCode, classify, vote } from "../comptoir/router.ts";
import { fixed, round } from "../comptoir/rounding.ts";

export interface TestMessage {
  id: string;
  message: string;
  expected: string;
}

const SETTINGS: Record<string, ClassifyOptions & { model: string }> = {
  haiku: { model: "claude-haiku-5-5" },
  "haiku-no-thinking": { model: "claude-haiku-5-5", noThinking: true },
  "sonnet-low": { model: "claude-sonnet-5-5", effort: "low" },
};

export function loadMessages(): TestMessage[] {
  return JSON.parse(readFileSync(join(PYTHON, "ch12", "messages.json"), "utf8")) as TestMessage[];
}

/** A line of results/routing.csv: the same columns as in the Python version. */
interface Line {
  setting: string;
  id: string;
  pass: number;
  expected: string;
  obtained: string;
  reason: string;
  by: string;
  cost_dollars: number;
  duration_s: number;
}

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    args: multipleValues(["settings"]),
    options: {
      settings: { type: "string", multiple: true, default: Object.keys(SETTINGS) },
      repetitions: { type: "string", default: "3" },
      "max-budget": { type: "string", default: "0.5" },
    },
  });
  const unknown = args.settings.filter((s) => !(s in SETTINGS));
  if (unknown.length) throw new Error(`--settings: ${unknown.join(", ")}? Choices: ${Object.keys(SETTINGS).join(", ")}.`);
  const repetitions = Number(args.repetitions);
  const maxBudget = Number(args["max-budget"]);

  const client = new Anthropic();
  const messages = loadMessages();
  const lines: Line[] = [];
  let spent = 0;
  for (const name of args.settings) {
    for (const m of messages) {
      for (let pass = 1; pass <= repetitions; pass++) {
        if (spent >= maxBudget) {
          console.error(`Budget of $${maxBudget} reached: stopping.`); // SystemExit in Python: nothing is written
          process.exit(1);
        }
        const start = performance.now();
        let decision: Decision;
        try {
          decision = byCode(m.message) ?? (await classify(client, m.message, SETTINGS[name]!));
        } catch (error) {
          if (!(error instanceof RoutingImpossible)) throw error;
          decision = { category: "error", reason: error.message, by: SETTINGS[name]!.model, cost: 0 }; // counted as a classification error
        }
        const duration = (performance.now() - start) / 1000;
        spent += decision.cost;
        lines.push({
          setting: name, id: m.id, pass, expected: m.expected, obtained: decision.category, reason: decision.reason,
          by: decision.by, cost_dollars: round(decision.cost, 6), duration_s: round(duration, 2),
        });
      }
    }
  }

  const output = join(ROOT, "ch12", "results", "routing.csv");
  writeCsv(lines, ["setting", "id", "pass", "expected", "obtained", "reason", "by", "cost_dollars", "duration_s"], output, ["cost_dollars", "duration_s"]);

  console.log(
    `${"setting".padEnd(22)} ${"success".padStart(9)} ${"vote of 3".padStart(9)} ${"missed compl.".padStart(15)} ` +
      `${"cost/message".padStart(13)} ${"median dur.".padStart(11)}`,
  );
  for (const name of args.settings) {
    const g = lines.filter((l) => l.setting === name);
    const correct = g.filter((l) => l.obtained === l.expected).length;
    const votes = new Map<string, string>();
    for (const m of messages) {
      const passes = g.filter((l) => l.id === m.id && l.obtained !== "error").map((l) => ({ category: l.obtained }));
      votes.set(m.id, passes.length ? vote(passes) : "error");
    }
    const voteCorrect = messages.filter((m) => votes.get(m.id) === m.expected).length;
    const missed = g.filter((l) => l.expected === "complaint" && l.obtained !== "complaint").length;
    const calls = g.filter((l) => l.by !== "code");
    console.log(
      `${name.padEnd(22)} ${String(correct).padStart(4)}/${String(g.length).padEnd(4)} ${String(voteCorrect).padStart(4)}/${String(messages.length).padEnd(4)} ` +
        `${String(missed).padStart(15)} ${fixed(mean(calls.map((l) => l.cost_dollars)), 6).padStart(13)} ` +
        `${fixed(median(calls.map((l) => l.duration_s)), 1).padStart(10)}s`,
    );
    const errors = new Map<string, number>();
    for (const l of g) if (l.obtained !== l.expected) errors.set(JSON.stringify([l.id, l.expected, l.obtained]), (errors.get(JSON.stringify([l.id, l.expected, l.obtained])) ?? 0) + 1);
    const sorted = [...errors].map(([key, n]) => [JSON.parse(key) as string[], n] as const).sort(([a], [b]) => (a.join("\0") < b.join("\0") ? -1 : 1));
    for (const [[id, expected, obtained], n] of sorted) console.log(`${"".padEnd(22)}   ${id}: ${expected} → ${obtained} (${n} times out of ${repetitions})`);
  }
  console.log(`\nSpent: $${spent.toFixed(4)}; details: ${output}`);
}

if (isMain(import.meta.url)) await main();
