// Evaluate variants (prompts, models, settings) on the same set of cases (chapter 5).
//
// A variant is a function that, for a case, returns the request to send. Each case is asked several
// times, graded, and compared: success, cost per success, regressions. Chapter 17 turns this into a real
// evaluation suite.

import type Anthropic from "@anthropic-ai/sdk";
import { performance } from "node:perf_hooks";
import { type MessagesClient, textOf } from "./client.ts";
import { cost } from "./costs.ts";
import { readCsv as read, writeCsv as write } from "./csv.ts";
import { logCall } from "./log.ts";
import { type Case, type Grade, grade } from "./notation.ts";
import { round } from "./rounding.ts";

export type Variant = (c: Case) => Anthropic.MessageCreateParamsNonStreaming;

/** A trial: the columns of results/trials.csv, the same as in the Python version. */
export interface Trial {
  variant: string;
  case: string;
  repetition: number;
  passed: boolean;
  reasons: string;
  to_review: string;
  answer: string;
  latency_s: number;
  input_tokens: number;
  output_tokens: number;
  cost_dollars: number;
  stop_reason: string;
}

const COLUMNS: (keyof Trial)[] = [
  "variant", "case", "repetition", "passed", "reasons", "to_review", "answer",
  "latency_s", "input_tokens", "output_tokens", "cost_dollars", "stop_reason",
];

/** The case's criteria, plus a common rule: an answer that does not stop on end_turn fails. */
export function gradeTrial(c: Case, text: string, stopReason: string | null): Grade {
  const result = grade(c, text);
  if (stopReason !== "end_turn") {
    result.passed = false;
    result.reasons.push(`stop: ${stopReason}`);
  }
  return result;
}

export async function runTrial(
  client: MessagesClient,
  name: string,
  request: Anthropic.MessageCreateParamsNonStreaming,
  c: Case,
  repetition: number,
): Promise<Trial> {
  const start = performance.now();
  const message = await client.messages.create(request);
  const latency = (performance.now() - start) / 1000;
  const text = textOf(message);
  const price = cost(request.model, message.usage);
  logCall(message._request_id, request.model, price, { prompt: name });
  const result = gradeTrial(c, text, message.stop_reason);
  return {
    variant: name,
    case: c.id,
    repetition,
    passed: result.passed,
    reasons: result.reasons.join("; "),
    to_review: result.toReview,
    answer: text,
    latency_s: round(latency, 2),
    input_tokens: price.input,
    output_tokens: price.output,
    cost_dollars: price.dollars,
    stop_reason: message.stop_reason ?? "",
  };
}

export async function evaluate(
  client: MessagesClient,
  cases: Case[],
  variants: Record<string, Variant>,
  repetitions: number,
  maxBudget: number,
): Promise<Trial[]> {
  const trials: Trial[] = [];
  let spent = 0;
  for (const [name, build] of Object.entries(variants)) {
    for (const c of cases) {
      for (let r = 1; r <= repetitions; r++) {
        if (spent >= maxBudget) {
          console.log(`Budget of $${maxBudget} reached: stopping.`);
          return trials;
        }
        const trial = await runTrial(client, name, build(c), c, r);
        spent += trial.cost_dollars;
        trials.push(trial);
      }
    }
  }
  return trials;
}

export interface Summary {
  variant: string;
  trials: number;
  success: number;
  costPerCall: number;
  costPerSuccess: number | null;
  medianLatencyS: number;
}

const total = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const median = (values: number[]): number => {
  const v = [...values].sort((a, b) => a - b);
  const middle = Math.floor(v.length / 2);
  return v.length % 2 ? v[middle]! : (v[middle - 1]! + v[middle]!) / 2;
};

export function summarize(trials: Trial[]): Summary[] {
  return [...new Set(trials.map((t) => t.variant))].map((name) => {
    const group = trials.filter((t) => t.variant === name);
    const successes = group.filter((t) => t.passed).length;
    const spent = total(group.map((t) => t.cost_dollars));
    return {
      variant: name,
      trials: group.length,
      success: successes / group.length,
      costPerCall: spent / group.length,
      costPerSuccess: successes ? spent / successes : null,
      medianLatencyS: median(group.map((t) => t.latency_s)),
    };
  });
}

export function ratePerCase(trials: Trial[], variant: string): Map<string, number> {
  const perCase = new Map<string, boolean[]>();
  for (const t of trials) {
    if (t.variant === variant) perCase.set(t.case, [...(perCase.get(t.case) ?? []), t.passed]);
  }
  return new Map([...perCase].map(([c, v]) => [c, v.filter(Boolean).length / v.length]));
}

/** The cases better passed by the old variant than by the new one. */
export function regressions(trials: Trial[], before: string, after: string): string[] {
  const a = ratePerCase(trials, before);
  const b = ratePerCase(trials, after);
  return [...a].filter(([c, rate]) => b.has(c) && b.get(c)! < rate).map(([c]) => c).sort();
}

/**
 * Applies the current grid to answers already obtained: no call, no cost.
 *
 * To be kept for a correction of the grid decided for a written reason, and applied to all variants at
 * once; both results, before and after, are kept.
 */
export function regrade(trials: Trial[], cases: Case[]): Trial[] {
  const byId = new Map(cases.map((c) => [c.id, c]));
  return trials.map((t) => {
    const c = byId.get(t.case);
    if (!c) throw new Error(`Unknown case in the results: '${t.case}'`);
    const result = gradeTrial(c, t.answer, t.stop_reason);
    return { ...t, passed: result.passed, reasons: result.reasons.join("; "), to_review: result.toReview };
  });
}

/** Reads a results file back, from this version or from the Python version: the types come back intact. */
export function readCsv(path: string): Trial[] {
  return read(path).map((l) => ({
    variant: l.variant ?? "",
    case: l.case ?? "",
    repetition: Number(l.repetition),
    passed: l.passed === "True",
    reasons: l.reasons ?? "",
    to_review: l.to_review ?? "",
    answer: l.answer ?? "",
    latency_s: Number(l.latency_s),
    input_tokens: Number(l.input_tokens),
    output_tokens: Number(l.output_tokens),
    cost_dollars: Number(l.cost_dollars),
    stop_reason: l.stop_reason ?? "",
  }));
}

export function writeCsv(trials: Trial[], path: string): void {
  write(trials, COLUMNS, path, ["latency_s", "cost_dollars"]); // floats in Python
}
