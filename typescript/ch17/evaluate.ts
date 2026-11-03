// Chapter 17: the Comptoir's evaluation suite, on the command line.
//
// From the typescript/ folder:
//     npx tsx ch17/evaluate.ts estimate --set improvement --trials 3                  (free)
//     npx tsx ch17/evaluate.ts run --variant reference --set improvement --trials 3 --max-budget 1   (PAID)
//     npx tsx ch17/evaluate.ts judge <series> --model claude-haiku-5-5 --max-budget 0.3                (PAID)
//     npx tsx ch17/evaluate.ts summarize <series> [--judge-model claude-haiku-5-5]                     (free)
//     npx tsx ch17/evaluate.ts regrade <series> --reason "…"                                          (free)
//     npx tsx ch17/evaluate.ts graduate <series>                                                      (free)
//     npx tsx ch17/evaluate.ts regression --max-budget 0.3                       (PAID: the shipped version)
//
// The “verification” set is used only at the end, for the chosen version: the script asks for
// --i-am-shipping to run it, so that it is not used, without meaning to, for working.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { countingRequest, makeClient } from "../comptoir/call.ts";
import type { MessagesClient } from "../comptoir/client.ts";
import { RATES } from "../comptoir/costs.ts";
import { readCsv } from "../comptoir/csv.ts";
import { loadKnowledge } from "../comptoir/knowledge.ts";
import { PYTHON, ROOT, isMain, multipleValues } from "../comptoir/launch.ts";
import { mean, pythonJson, sum } from "../comptoir/python.ts";
import { fixed } from "../comptoir/rounding.ts";
import { grade } from "./code_grading.ts";
import { type EvaluationCase, type Trial, identifier, makeTrial } from "./harness.ts";
import * as judge_ from "./judge.ts";
import {
  VARIANTS, casesFingerprint, gradingFingerprint, judgmentsPath, jsonLine, loadCases, locations, nowUtc, outcome, percent,
  readJudgments, readSeries, recordInRegister, registerEntry, run, show, summarize, timestamp, writeSeries,
} from "./suite.ts";

const JUDGE_ASSUMED_OUTPUT = 600; // output tokens assumed per judgment, thinking included, for the estimate

/** Python's SystemExit: the message goes to the error output, and the script stops with code 1. */
export class Stop extends Error {}

/** What the tests replace, like monkeypatch.setattr: the client, Awa's base, the running of a series. */
export const dependencies = {
  makeClient: (): MessagesClient => makeClient(),
  loadKnowledge,
  run,
};

/** The average cost of a message per category, measured in chapter 12 with the router. */
export function costsOfChapter12(): Record<string, number> {
  // This version's measurements if they exist; otherwise the book's, made with the Python version.
  const path = [join(ROOT, "ch12", "results", "comptoir.csv"), join(PYTHON, "ch12", "results", "comptoir.csv")].find(existsSync)!;
  const rows = readCsv(path).filter((r) => r.mode === "routed");
  const categories = [...new Set(rows.map((r) => r.expected!))];
  return Object.fromEntries(categories.map((c) => [c, mean(rows.filter((r) => r.expected === c).map((r) => Number(r.cost_dollars)))]));
}

const fakeTrial = (c: EvaluationCase): Trial => makeTrial("estimate", c.id, 1, { text: "Example answer.", claude_text: "Example answer." });

export async function cmdEstimate(args: { set: string; trials: number; judgeModel: string }): Promise<void> {
  const cases = loadCases(args.set);
  const averages = costsOfChapter12();
  const total = sum(cases.map((c) => averages[c.category[0]!]!)) * args.trials;
  console.log(
    `${cases.length} cases × ${args.trials} trials with the shipped version: about $${fixed(total, 2)} ` +
      "(average costs measured in chapter 12: " +
      Object.entries(averages).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k} $${fixed(v, 4)}`).join(", ") + ")",
  );
  const client = dependencies.makeClient();
  const example = judge_.request(cases[0]!, fakeTrial(cases[0]!), args.judgeModel);
  const inputTokens = (await client.messages.countTokens(countingRequest(example))).input_tokens;
  const rate = RATES[args.judgeModel]!;
  const perJudgment = (inputTokens * rate.input + JUDGE_ASSUMED_OUTPUT * rate.output) / 1_000_000;
  console.log(
    `Judge ${args.judgeModel}: ${inputTokens} input tokens per judgment (free counting), at most ` +
      `$${fixed(perJudgment, 4)} without the cache, that is $${fixed(perJudgment * cases.length * args.trials, 2)} for all the trials`,
  );
}

export interface RunArgs {
  variant: string;
  set: string;
  cases: string[] | null;
  trials: number;
  maxBudget: number;
  parallel: number;
  iAmShipping: boolean;
}

export async function cmdRun(args: RunArgs): Promise<void> {
  if (args.set === "verification" && !args.iAmShipping) {
    throw new Stop("The verification set is run once, for the chosen version: add --i-am-shipping.");
  }
  const v = VARIANTS[args.variant]!;
  const cases = loadCases(args.set, args.cases);
  const folder = join(locations.series, `${timestamp()}-${v.name}-${args.set}`);
  console.log(`Variant ${v.name} · set ${args.set} (${cases.length} cases, fingerprint ${casesFingerprint(cases)}) · ${args.trials} trials · ceiling $${args.maxBudget}`);
  const [trials, stopped] = await dependencies.run(dependencies.makeClient(), v, cases, args.trials, args.maxBudget, dependencies.loadKnowledge(), args.parallel);
  writeSeries(folder, trials);
  const summary = summarize(trials, cases);
  recordInRegister(registerEntry(folder, v, args.set, cases, args.trials, summary, stopped));
  console.log((stopped ? "\nBUDGET REACHED: incomplete series.\n" : "\n") + show(summary));
  console.log(`Series: ${folder}`);
}

export async function cmdJudge(args: { series: string; model: string; rubric: string; sample: string | null; maxBudget: number; parallel: number }): Promise<void> {
  let trials = readSeries(args.series);
  if (args.sample) {
    const kept = new Set((JSON.parse(readFileSync(args.sample, "utf8")) as { trials: string[] }).trials);
    trials = trials.filter((t) => kept.has(identifier(t)));
  }
  const already = readJudgments(args.series, args.model, args.rubric);
  const toJudge = trials.filter((t) => !(identifier(t) in already));
  const cases = new Map(loadCases().map((c) => [c.id, c]));
  const rubric = judge_.loadRubric(args.rubric);
  const client = dependencies.makeClient();
  const path = judgmentsPath(args.series, args.model, args.rubric);
  let spent = 0;
  console.log(`${toJudge.length} trials to judge by ${args.model} (${rubric.id}), ${Object.keys(already).length} already judged`);

  const one = async (trial: Trial): Promise<void> => {
    if (spent >= args.maxBudget) return;
    const j = await judge_.judge(client, cases.get(trial.case)!, trial, args.model, rubric);
    spent += j.cost_dollars;
    const result = outcome(j);
    writeFileSync(path, jsonLine({ ...j, outcome: result }) + "\n", { encoding: "utf8", flag: "a" });
    console.log(
      `  ${identifier(trial).padEnd(45)} ${result.padEnd(9)} $${fixed(j.cost_dollars, 5)} ` +
        Object.entries(j.verdicts).map(([c, v]) => `${c}=${v}`).join(" ") + (j.error ? ` ${j.error}` : ""),
    );
  };

  if (toJudge.length) {
    await one(toJudge[0]!); // the first one alone: it writes the documents to the cache
    const queue = toJudge.slice(1);
    await Promise.all(Array.from({ length: args.parallel }, async () => {
      while (queue.length) await one(queue.shift()!);
    }));
  }
  console.log(`Judge's spending: $${fixed(spent, 4)}`);
  cmdSummarize({ series: args.series, judgeModel: args.model, rubric: args.rubric });
}

export function cmdSummarize(args: { series: string; judgeModel: string | null; rubric: string }): void {
  const trials = readSeries(args.series);
  const judgments = args.judgeModel ? readJudgments(args.series, args.judgeModel, args.rubric) : null;
  console.log(show(summarize(trials, loadCases(), judgments)));
}

/**
 * The current grading, applied to the answers already obtained: no call, no cost. A new line enters the
 * register, with the new fingerprint of the grading; the old one stays.
 */
export function cmdRegrade(args: { series: string; reason: string }): void {
  const lines = readFileSync(locations.register, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  const before = lines.reverse().find((l) => l.series === basename(args.series));
  if (!before) throw new Stop(`The series ${basename(args.series)} is not in the register ${locations.register}.`);
  const trials = readSeries(args.series);
  const cases = loadCases(null, [...new Set(trials.map((t) => t.case))].sort());
  const summary = summarize(trials, cases);
  const entry = {
    ...before, summary, grading_fingerprint: gradingFingerprint(), cases_fingerprint: casesFingerprint(cases), regrading: true, date: nowUtc(), reason: args.reason,
  };
  recordInRegister(entry);
  console.log(`Grading ${before.grading_fingerprint}: success (code) ${percent((before.summary as { code_success: number }).code_success)}`);
  console.log(`Grading ${entry.grading_fingerprint}: success (code) ${percent(summary.code_success)}`);
  console.log(show(summary));
}

/**
 * The cases the code passes at every trial of a series enter the regression: from “can we do it?”, they
 * move to “do we still do it?”.
 */
export function cmdGraduate(args: { series: string }): void {
  const trials = readSeries(args.series);
  const cases = new Map(loadCases().map((c) => [c.id, c]));
  const byCase = new Map<string, boolean[]>();
  for (const t of trials) byCase.set(t.case, [...(byCase.get(t.case) ?? []), !grade(cases.get(t.case)!, t).length]);
  const kept = [...byCase].filter(([, v]) => v.every(Boolean)).map(([c]) => c).sort();
  writeFileSync(locations.regression, pythonJson({ series: basename(args.series), grading_fingerprint: gradingFingerprint(), cases: kept }, 1), "utf8");
  console.log(`${kept.length} cases out of ${byCase.size} enter the regression → ${locations.regression}`);
}

/**
 * The cases the shipped version passes at every trial: one trial each, graded by the code. Returns 1 at the
 * first failure: enough to block a change, by hand or in CI (chapter 20).
 */
export async function cmdRegression(args: { variant: string; maxBudget: number; parallel: number }): Promise<number> {
  const ids = (JSON.parse(readFileSync(locations.regression, "utf8")) as { cases: string[] }).cases;
  const cases = loadCases(null, ids);
  const v = VARIANTS[args.variant]!;
  const [trials, stopped] = await dependencies.run(dependencies.makeClient(), v, cases, 1, args.maxBudget, dependencies.loadKnowledge(), args.parallel);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const failed = trials.filter((t) => grade(byId.get(t.case)!, t).length).map((t) => t.case).sort();
  const folder = join(locations.series, `${timestamp()}-${v.name}-regression`);
  writeSeries(folder, trials);
  const summary = summarize(trials, cases);
  recordInRegister(registerEntry(folder, v, "regression", cases, 1, summary, stopped));
  console.log(show(summary));
  if (stopped || failed.length) {
    console.log(`REGRESSION: ${stopped ? "incomplete series; " : ""}${failed.length} cases failed: ${failed.join(", ")}`);
    return 1;
  }
  console.log(`Regression: ${cases.length} cases out of ${cases.length}.`);
  return 0;
}

const choice = (value: string, allowed: string[], option: string): string => {
  if (!allowed.includes(value)) throw new Stop(`${option}: ${value}? Choices: ${allowed.join(", ")}.`);
  return value;
};

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { values: a, positionals } = parseArgs({
    args: multipleValues(["cases"], rest),
    allowPositionals: true,
    options: {
      set: { type: "string", default: "improvement" },
      trials: { type: "string", default: "3" },
      "judge-model": { type: "string" },
      variant: { type: "string" },
      cases: { type: "string", multiple: true }, //   only these cases
      "max-budget": { type: "string" },
      parallel: { type: "string", default: "4" },
      "i-am-shipping": { type: "boolean", default: false },
      model: { type: "string", default: "claude-haiku-5-5" },
      rubric: { type: "string", default: judge_.RUBRIC },
      sample: { type: "string" },
      reason: { type: "string" }, //                 why the grading changed, written to the register
    },
  });
  const variants = Object.keys(VARIANTS).sort();
  switch (command) {
    case "estimate":
      await cmdEstimate({ set: a.set, trials: Number(a.trials), judgeModel: a["judge-model"] ?? "claude-haiku-5-5" });
      return 0;
    case "run":
      await cmdRun({
        variant: choice(a.variant ?? "reference", variants, "--variant"), set: choice(a.set, ["improvement", "verification"], "--set"),
        cases: (a.cases ?? []).filter(Boolean), trials: Number(a.trials), maxBudget: Number(a["max-budget"] ?? "1"), parallel: Number(a.parallel), iAmShipping: a["i-am-shipping"],
      });
      return 0;
    case "judge":
      await cmdJudge({ series: positionals[0]!, model: a.model, rubric: a.rubric, sample: a.sample ?? null, maxBudget: Number(a["max-budget"] ?? "0.3"), parallel: Number(a.parallel) });
      return 0;
    case "summarize":
      cmdSummarize({ series: positionals[0]!, judgeModel: a["judge-model"] ?? null, rubric: a.rubric });
      return 0;
    case "regrade":
      if (!a.reason) throw new Stop("--reason is required: why the grading changed, written to the register.");
      cmdRegrade({ series: positionals[0]!, reason: a.reason });
      return 0;
    case "graduate":
      cmdGraduate({ series: positionals[0]! });
      return 0;
    case "regression":
      return cmdRegression({ variant: choice(a.variant ?? "shipped", variants, "--variant"), maxBudget: Number(a["max-budget"] ?? "0.3"), parallel: Number(a.parallel) });
    default:
      throw new Stop("Command: estimate, run, judge, summarize, regrade, graduate or regression.");
  }
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      if (!(error instanceof Stop)) throw error;
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
