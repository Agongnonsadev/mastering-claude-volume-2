// Chapter 3: compare models and effort levels on the Comptoir's cases.
//
// For each configuration (model, effort), each case is asked several times, because answers vary. The
// success, the cost, the latency and the thinking are recorded, then the cost per successful task is
// calculated.
//
// Run, from the typescript/ folder:
//     npx tsx ch03/compare_models.ts --estimate        # free: cost estimate before running
//     npx tsx ch03/compare_models.ts --repetitions 3 --max-budget 2

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { SYSTEM_PROMPT } from "../ch02/comptoir_cli.ts";
import { type MessagesClient, textOf } from "../comptoir/client.ts";
import { RATES, cost } from "../comptoir/costs.ts";
import { writeCsv as write } from "../comptoir/csv.ts";
import { PYTHON, ROOT, isMain } from "../comptoir/launch.ts";
import { logCall } from "../comptoir/log.ts";
import { type Case, grade, makeCase } from "../comptoir/notation.ts";
import { round } from "../comptoir/rounding.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Configuration = readonly [model: string, effort: Effort];

export const CONFIGURATIONS: Configuration[] = [
  ["claude-opus-5-5", "medium"],
  ["claude-opus-5-5", "low"],
  ["claude-sonnet-5-5", "high"],
  ["claude-sonnet-5-5", "low"],
  ["claude-haiku-5-5", "medium"],
  ["claude-haiku-5-5", "low"],
];

/** The book's 15 cases, those of the Python version (python/ch03/cases.json). */
export function loadCases(path = join(PYTHON, "ch03", "cases.json")): Case[] {
  return (JSON.parse(readFileSync(path, "utf8")) as Parameters<typeof makeCase>[0][]).map(makeCase);
}

/** A trial: the columns of results/trials.csv, the same as in the Python version. */
export interface Trial {
  model: string;
  effort: string;
  case: string;
  repetition: number;
  passed: boolean;
  reasons: string;
  to_review: string;
  answer: string;
  latency_s: number;
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cost_dollars: number;
  stop_reason: string | null;
}

export async function ask(client: MessagesClient, model: string, effort: Effort, c: Case, repetition: number): Promise<Trial> {
  const start = performance.now();
  const message = await client.messages.create({
    model,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    output_config: { effort },
    messages: [{ role: "user", content: c.question }],
  });
  const latency = (performance.now() - start) / 1000;
  const text = textOf(message);
  const price = cost(model, message.usage);
  logCall(message._request_id, model, price);
  const result = grade(c, text);
  if (message.stop_reason !== "end_turn") {
    result.passed = false;
    result.reasons.push(`stop: ${message.stop_reason}`);
  }
  return {
    model,
    effort,
    case: c.id,
    repetition,
    passed: result.passed,
    reasons: result.reasons.join("; "),
    to_review: result.toReview,
    answer: text,
    latency_s: round(latency, 2),
    input_tokens: price.input,
    output_tokens: price.output,
    thinking_tokens: price.thinking,
    cost_dollars: price.dollars,
    stop_reason: message.stop_reason,
  };
}

export interface Summary {
  model: string;
  effort: string;
  trials: number;
  success: number;
  costPerCall: number;
  /** The figure that counts: what a usable answer costs. */
  costPerSuccess: number | null;
  medianLatencyS: number;
  averageThinking: number;
}

const median = (values: number[]): number => {
  const v = [...values].sort((a, b) => a - b);
  const middle = Math.floor(v.length / 2);
  return v.length % 2 ? v[middle]! : (v[middle - 1]! + v[middle]!) / 2;
};
const total = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/** One line per configuration: success rate, costs, latency, thinking. */
export function summarize(trials: Trial[]): Summary[] {
  const configurations = [...new Set(trials.map((t) => `${t.model}\u0000${t.effort}`))];
  return configurations.map((key) => {
    const group = trials.filter((t) => `${t.model}\u0000${t.effort}` === key);
    const successes = group.filter((t) => t.passed).length;
    const totalCost = total(group.map((t) => t.cost_dollars));
    return {
      model: group[0]!.model,
      effort: group[0]!.effort,
      trials: group.length,
      success: successes / group.length,
      costPerCall: totalCost / group.length,
      costPerSuccess: successes ? totalCost / successes : null,
      medianLatencyS: median(group.map((t) => t.latency_s)),
      averageThinking: total(group.map((t) => t.thinking_tokens)) / group.length,
    };
  });
}

export async function compare(
  client: MessagesClient,
  cases: Case[],
  configurations: readonly Configuration[],
  repetitions: number,
  maxBudget: number,
): Promise<Trial[]> {
  const trials: Trial[] = [];
  let spent = 0;
  for (const [model, effort] of configurations) {
    for (const c of cases) {
      for (let r = 1; r <= repetitions; r++) {
        if (spent >= maxBudget) {
          console.log(`Budget of $${maxBudget} reached: stopping the comparison.`);
          return trials;
        }
        const trial = await ask(client, model, effort, c, r);
        spent += trial.cost_dollars;
        trials.push(trial);
      }
    }
  }
  return trials;
}

/** Free estimate: input tokens counted, output tokens assumed. */
export async function estimate(
  client: MessagesClient,
  cases: Case[],
  configurations: readonly Configuration[],
  repetitions: number,
  assumedOutput: number,
): Promise<number> {
  let sum = 0;
  for (const [model] of configurations) {
    const rate = RATES[model];
    if (!rate) throw new Error(`Unknown price for the model '${model}': add it to RATES.`);
    for (const c of cases) {
      const { input_tokens: input } = await client.messages.countTokens({
        model,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: c.question }],
      });
      sum += (repetitions * (input * rate.input + assumedOutput * rate.output)) / 1_000_000;
    }
  }
  return sum;
}

export function writeCsv(trials: Trial[], path: string): void {
  write(trials, [
    "model", "effort", "case", "repetition", "passed", "reasons", "to_review", "answer",
    "latency_s", "input_tokens", "output_tokens", "thinking_tokens", "cost_dollars", "stop_reason",
  ], path, ["latency_s", "cost_dollars"]); // floats in Python
}

export function show(lines: Summary[]): void {
  console.log(
    `${"Model".padEnd(20)}${"Effort".padEnd(8)}${"Success".padStart(10)}${"$/call".padStart(11)}` +
      `${"$/success".padStart(12)}${"Latency".padStart(9)}${"Thinking".padStart(11)}`,
  );
  for (const l of lines) {
    const perSuccess = l.costPerSuccess ? l.costPerSuccess.toFixed(5) : "—";
    console.log(
      `${l.model.padEnd(20)}${l.effort.padEnd(8)}${`${Math.round(l.success * 100)}%`.padStart(9)} ` +
        `${l.costPerCall.toFixed(5).padStart(10)}${perSuccess.padStart(12)}` +
        `${l.medianLatencyS.toFixed(1).padStart(8)}s${Math.round(l.averageThinking).toString().padStart(11)}`,
    );
  }
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      repetitions: { type: "string", default: "3" },
      "max-budget": { type: "string", default: "2.0" }, //   stop beyond this amount, in dollars
      estimate: { type: "boolean", default: false }, //      estimate the cost without calling the model
      "assumed-output": { type: "string", default: "300" }, // output tokens assumed per call
    },
  });
  const repetitions = Number(args.repetitions);
  const assumedOutput = Number(args["assumed-output"]);

  const client = new Anthropic();
  const cases = loadCases();
  if (args.estimate) {
    const sum = await estimate(client, cases, CONFIGURATIONS, repetitions, assumedOutput);
    console.log(`${cases.length} cases × ${CONFIGURATIONS.length} configurations × ${repetitions} repetitions`);
    console.log(`Estimated cost: $${sum.toFixed(2)} (with ${assumedOutput} output tokens assumed per call)`);
    return;
  }

  const trials = await compare(client, cases, CONFIGURATIONS, repetitions, Number(args["max-budget"]));
  writeCsv(trials, join(ROOT, "ch03", "results", "trials.csv"));
  show(summarize(trials));
  const toReview = [...new Map(trials.filter((t) => t.to_review).map((t) => [t.case, t.to_review])).entries()].sort();
  if (toReview.length) {
    console.log("\nTo review by hand (see results/trials.csv):");
    for (const [caseId, instruction] of toReview) console.log(`- ${caseId}: ${instruction}`);
  }
}

if (isMain(import.meta.url)) await main();
