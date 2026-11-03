// The Comptoir's evaluation suite (chapter 17): run, grade, summarize, keep the record.
//
// - the cases live in python/ch17/cases.json, shared by both versions, each in a set: “improvement” to
//   work, “verification” to check, only once, the chosen version;
// - each series of trials goes into its own folder of ch17/results/series/, with all the transcripts; a
//   line enters ch17/results/register.jsonl: the variant, the versions of the prompts, the fingerprint of
//   the cases and of the grading, the results and the cost. Two series compare only if they received the
//   same messages (the cases' fingerprint); their answers are then graded together, by the grading of the
//   day: the code's, the references and the judge's rubric apply to both at once.
//
// The files have the shape of the Python version's, floating-point numbers included (“0.0”): a series made
// by one is read, summarized and compared by the other.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MessagesClient } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import { loadPrompt } from "../comptoir/doc_assistant.ts";
import type { Chunk } from "../comptoir/knowledge.ts";
import { PYTHON, ROOT } from "../comptoir/launch.ts";
import { load } from "../comptoir/prompt.ts";
import { PyFloat, floatText, mean, median, pythonJson, repr, sum } from "../comptoir/python.ts";
import { fixed, round } from "../comptoir/rounding.ts";
import { PROMPT as ROUTER_PROMPT } from "../comptoir/router.ts";
import { grade } from "./code_grading.ts";
import { type EvaluationCase, TRIAL_FIELDS, type Trial, type Variant, identifier, makeTrial, runTrial, variant } from "./harness.ts";

export const FOLDER = join(ROOT, "ch17");
/** The data shared by both versions: the cases, the regression list, the judge's rubrics. */
export const DATA = join(PYTHON, "ch17");

/** Where the results go; the tests change them for the time of a test, like monkeypatch.setattr. */
export const locations = {
  series: join(FOLDER, "results", "series"),
  register: join(FOLDER, "results", "register.jsonl"),
  // The list of regression cases is shared by both versions: a single list, like the cases.
  regression: join(DATA, "regression.json"),
  // The harness itself, which the budget test replaces.
  runTrial,
};

const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
export const VARIANTS: Record<string, Variant> = {
  // The version shipped before this chapter: the Comptoir on Claude Sonnet 5.5.
  reference: variant("reference", { comptoir_model: SONNET }),
  // One change at a time, each compared with the reference.
  // The prompt: the length rule gets its means (system_v4.md, one more sentence).
  "prompt-v4": variant("prompt-v4", { comptoir_model: SONNET, prompt_version: "v4" }),
  // The Comptoir's model: Claude Haiku 5.5, twenty times cheaper than Sonnet 5.5 (comptoir/costs.ts).
  haiku: variant("haiku", { comptoir_model: HAIKU }),
  // Chapter 18: the prompt tells the Comptoir that it is an AI, and what to answer to “are you Awa?”.
  // Compared with “haiku” (same model, prompt v3): 5 cases won, 3 lost, p = 0.73; kept.
  "prompt-v5": variant("prompt-v5", { prompt_version: "v5" }),
  // The shipped version: Haiku 5.5 (comptoir/config.ts) since chapter 17, prompt v5 since chapter 18.
  shipped: variant("shipped", { prompt_version: "v5" }),
  // Chapter 19: the Comptoir's effort at low, which the documentation advises for chat; compared with “shipped”.
  "effort-low": variant("effort-low", { prompt_version: "v5", comptoir_effort: "low" }),
};

/** 8 characters that change as soon as a single character changes. */
export const fingerprint = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);

/** A text file read like read_text() in Python: the line endings brought back to \n. */
export const readText = (path: string): string => readFileSync(path, "utf8").replace(/\r\n?/g, "\n");

export function loadCases(caseSet: string | null = null, ids: string[] | null = null): EvaluationCase[] {
  let cases = JSON.parse(readFileSync(join(DATA, "cases.json"), "utf8")) as EvaluationCase[];
  if (caseSet) cases = cases.filter((c) => c.set === caseSet);
  if (ids?.length) cases = cases.filter((c) => ids.includes(c.id));
  return cases;
}

/**
 * What makes the answers: the IDs and the messages. The criteria and the references can be corrected,
 * they then apply to all the series at once. The same fingerprint as in Python.
 */
export const casesFingerprint = (cases: EvaluationCase[]): string => fingerprint(pythonJson(cases.map((c) => [c.id, c.message])));

/** The fingerprint of this version's grading (its code, and that of chapter 3 it depends on). */
export function gradingFingerprint(): string {
  const sources = [join(FOLDER, "code_grading.ts"), join(ROOT, "comptoir", "notation.ts")];
  return fingerprint(sources.map(readText).join(""));
}

/** Everything that makes the variant, with the fingerprint of each prompt: enough to find it again. */
export function versions(v: Variant): Record<string, string> {
  return {
    comptoir_model: v.comptoir_model || config.COMPTOIR_MODEL,
    comptoir_effort: v.comptoir_effort || config.COMPTOIR_EFFORT || "model default",
    router_model: config.ROUTER_MODEL,
    documents_model: config.DOCUMENTS_MODEL,
    complaints_model: `${config.AUXILIARY_MODEL} and ${config.MODEL}`,
    comptoir_prompt: load(v.prompt_version).id,
    documents_prompt: loadPrompt(v.documents_version).id,
    router_prompt: `router-v1@${fingerprint(ROUTER_PROMPT)}`,
  };
}

// --- Run ------------------------------------------------------------------------------

/**
 * Each case, `trials` times. A first trial per path (information, order, complaint, other) goes alone: it
 * writes the caches the following ones will read, instead of four writes in parallel. Returns the trials
 * and true if the budget stopped the series before the end.
 */
export async function run(
  client: MessagesClient | null,
  v: Variant,
  cases: EvaluationCase[],
  trials: number,
  maxBudget: number,
  base: Chunk[],
  parallel = 4,
  progress: (line: string) => void = console.log,
): Promise<[Trial[], boolean]> {
  type Task = [EvaluationCase, number];
  let tasks: Task[] = [];
  for (let n = 1; n <= trials; n++) for (const c of cases) tasks.push([c, n]);
  const order = new Map(tasks.map(([c, n], rank) => [`${c.id}/${n}`, rank]));
  const paths = new Set<string>();
  const alone: Task[] = [];
  for (const t of tasks) {
    if (!paths.has(t[0].category[0]!)) {
      paths.add(t[0].category[0]!);
      alone.push(t);
    }
  }
  tasks = [...alone, ...tasks.filter((t) => !alone.includes(t))];
  const results: Trial[] = [];
  let spent = 0;

  const one = async ([c, n]: Task): Promise<Trial> => {
    const trial = await locations.runTrial(client as MessagesClient, v, c, n, base);
    const failures = grade(c, trial);
    progress(
      `  ${identifier(trial).padEnd(45)} ${failures.length ? "FAILED" : "ok"} $${fixed(trial.cost_dollars, 4)} ` +
        `${fixed(trial.latency_s, 1).padStart(5)} s ${[...failures.map((f) => f.reason).join("; ")].slice(0, 90).join("")}`,
    );
    return trial;
  };

  if (!tasks.length) return [[], false];
  for (const task of alone) {
    const trial = await one(task);
    results.push(trial);
    spent += trial.cost_dollars;
  }
  let stopped = false;
  let rest = tasks.slice(alone.length);
  const running = new Set<Promise<[Promise<unknown>, Trial]>>();
  while (rest.length || running.size) {
    while (rest.length && running.size < parallel) {
      if (spent >= maxBudget) {
        stopped = true;
        rest = [];
        break;
      }
      const promise: Promise<[Promise<unknown>, Trial]> = one(rest.shift()!).then((t) => [promise, t]);
      running.add(promise);
    }
    if (!running.size) break;
    const [done, trial] = await Promise.race(running);
    running.delete(done as Promise<[Promise<unknown>, Trial]>);
    results.push(trial);
    spent += trial.cost_dollars;
  }
  results.sort((a, b) => order.get(`${a.case}/${a.trial}`)! - order.get(`${b.case}/${b.trial}`)!);
  return [results, stopped];
}

// --- Write and read back --------------------------------------------------------------------

// The Python version's floating-point numbers: written “0.0”, and not “0”, in the files.
const FLOATS = new Set([
  "cost_dollars", "latency_s", "duration_s", // a trial, its calls, its steps; a judgment
  "code_success", "judge_success", "success", "judge_cost", "total_cost", "average_cost", "cost_per_success",
  "median_latency_s", "latency_p90_s", "common", "trap", "security", // a summary (by type: common, trap, security)
]);

function likePython(value: unknown, key: string | null = null): unknown {
  if (typeof value === "number" && key !== null && FLOATS.has(key)) return new PyFloat(value);
  if (Array.isArray(value)) return value.map((v) => likePython(v));
  if (value !== null && typeof value === "object" && !(value instanceof PyFloat)) {
    // A tool's input belongs to Claude: its numbers stay as they are.
    if (key === "input") return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, likePython(v, k)]));
  }
  return value;
}

/** A JSON line as json.dumps(…, ensure_ascii=False) writes it in Python. */
export const jsonLine = (value: unknown): string => pythonJson(likePython(value));

export function writeSeries(folder: string, trials: Trial[]): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "trials.jsonl"), trials.map((t) => jsonLine(t) + "\n").join(""), "utf8");
}

const jsonLines = (path: string): Record<string, unknown>[] =>
  readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

export function readSeries(folder: string): Trial[] {
  return jsonLines(join(folder, "trials.jsonl")).map((l) => {
    const fields = Object.fromEntries(TRIAL_FIELDS.filter((k) => k in l).map((k) => [k, l[k]])) as Partial<Trial>;
    return makeTrial(fields.variant!, fields.case!, fields.trial!, fields);
  });
}

/** A judgment as it is written: that of ch17/judge.ts, with its outcome. */
export interface WrittenJudgment {
  trial: string;
  model?: string;
  rubric?: string;
  verdicts: Record<string, string>;
  findings?: Record<string, string>;
  cost_dollars: number;
  error?: string | null;
  outcome?: string;
}

/** One file per judge and per version of the rubric: a corrected rubric does not mix its grades with the old ones. */
export const judgmentsPath = (folder: string, model: string, rubric = "v1"): string => join(folder, `judgments-${model}-${rubric}.jsonl`);

export function readJudgments(folder: string, model: string, rubric = "v1"): Record<string, WrittenJudgment> {
  const path = judgmentsPath(folder, model, rubric);
  if (!existsSync(path)) return {};
  return Object.fromEntries((jsonLines(path) as unknown as WrittenJudgment[]).map((j) => [j.trial, j]));
}

export function recordInRegister(entry: Record<string, unknown>): void {
  mkdirSync(dirname(locations.register), { recursive: true });
  appendFileSync(locations.register, jsonLine(entry) + "\n", "utf8");
}

// --- Summarize ------------------------------------------------------------------------------

function p90(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, round(0.9 * (sorted.length - 1)))]! : 0;
}

/** Python's Counter, as an object: each value with its count, in the order of first appearance. */
function count(values: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
}

export function outcome(judgment: Pick<WrittenJudgment, "verdicts" | "error">): "passed" | "failed" | "to_review" {
  const verdicts = Object.values(judgment.verdicts ?? {});
  if (judgment.error || !verdicts.length) return "to_review";
  return verdicts.includes("no") ? "failed" : verdicts.every((x) => x === "yes") ? "passed" : "to_review";
}

/** The summary of a series, with the Python version's names; the judge's fields are there only if it has been through. */
export interface Summary {
  trials: number;
  cases: number;
  code_success: number;
  failures_by_family: Record<string, number>;
  judged?: number;
  judge_success?: number;
  to_review?: number;
  no_by_criterion?: Record<string, number>;
  success?: number;
  judge_cost?: number;
  always_passed_cases: number;
  never_passed_cases: number;
  unstable_cases: string[];
  by_type: Record<string, number>;
  total_cost: number;
  average_cost: number;
  cost_per_success: number | null;
  median_latency_s: number | null;
  latency_p90_s: number | null;
  average_calls: number;
}

/**
 * Quality, cost and latency, together. A trial succeeds if the code finds nothing to object to, and, when
 * the judge has been through, if it says “yes” to all the criteria. If the judge read only a sample, the
 * summary covers only the judged trials.
 */
export function summarize(trials: Trial[], cases: EvaluationCase[], judgments: Record<string, WrittenJudgment> | null = null): Summary {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const judged = judgments !== null && Object.keys(judgments).length > 0; // `if judgments:` in Python
  if (judged) trials = trials.filter((t) => identifier(t) in judgments!);
  const grades = new Map(trials.map((t) => [identifier(t), grade(byId.get(t.case)!, t)]));
  const passedCode = new Set([...grades].filter(([, failures]) => !failures.length).map(([i]) => i));
  const summary: Record<string, unknown> = {
    trials: trials.length,
    cases: new Set(trials.map((t) => t.case)).size,
    code_success: trials.length ? passedCode.size / trials.length : 0,
    failures_by_family: count([...grades.values()].flatMap((failures) => failures.map((f) => f.family))),
  };
  let passed = new Set(passedCode);
  if (judged) {
    const kept = Object.values(judgments!).filter((j) => grades.has(j.trial));
    const outcomes = new Map(Object.entries(judgments!).filter(([i]) => grades.has(i)).map(([i, j]) => [i, outcome(j)]));
    summary.judged = outcomes.size;
    summary.judge_success = outcomes.size ? [...outcomes.values()].filter((v) => v === "passed").length / outcomes.size : 0;
    summary.to_review = [...outcomes.values()].filter((v) => v === "to_review").length;
    summary.no_by_criterion = count(kept.flatMap((j) => Object.entries(j.verdicts).filter(([, v]) => v === "no").map(([c]) => c)));
    passed = new Set([...passedCode].filter((i) => outcomes.get(i) === "passed"));
    summary.success = trials.length ? passed.size / trials.length : 0;
    summary.judge_cost = round(sum(kept.map((j) => j.cost_dollars)), 4);
  }
  const byCase = new Map<string, boolean[]>();
  for (const t of trials) byCase.set(t.case, [...(byCase.get(t.case) ?? []), passed.has(identifier(t))]);
  const lists = [...byCase.values()];
  summary.always_passed_cases = lists.filter((v) => v.every(Boolean)).length;
  summary.never_passed_cases = lists.filter((v) => !v.some(Boolean)).length;
  summary.unstable_cases = [...byCase].filter(([, v]) => v.some(Boolean) && !v.every(Boolean)).map(([c]) => c).sort();
  const byType: Record<string, number> = {};
  for (const kind of ["common", "trap", "security"]) {
    const group = trials.filter((t) => byId.get(t.case)!.type === kind);
    if (group.length) byType[kind] = group.filter((t) => passed.has(identifier(t))).length / group.length;
  }
  summary.by_type = byType;
  const costs = trials.map((t) => t.cost_dollars);
  const latencies = trials.filter((t) => !t.error).map((t) => t.latency_s);
  Object.assign(summary, {
    total_cost: round(sum(costs), 4),
    average_cost: costs.length ? round(mean(costs), 5) : 0,
    cost_per_success: passed.size ? round(sum(costs) / passed.size, 5) : null,
    median_latency_s: latencies.length ? round(median(latencies), 1) : null,
    latency_p90_s: latencies.length ? round(p90(latencies), 1) : null,
    average_calls: trials.length ? round(mean(trials.map((t) => t.calls.length)), 2) : 0,
  });
  return summary as unknown as Summary;
}

export function ratePerCase(trials: Trial[], cases: EvaluationCase[], judgments: Record<string, WrittenJudgment> | null = null): Record<string, number> {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const byCase = new Map<string, boolean[]>();
  for (const t of trials) {
    let ok = !grade(byId.get(t.case)!, t).length;
    if (judgments !== null) ok &&= identifier(t) in judgments && outcome(judgments[identifier(t)]!) === "passed";
    byCase.set(t.case, [...(byCase.get(t.case) ?? []), ok]);
  }
  return Object.fromEntries([...byCase].map(([c, v]) => [c, v.filter(Boolean).length / v.length]));
}

/** f"{x:.0%}" in Python: 0.875 is written “88%” (the half to even, on x × 100). */
export const percent = (x: number): string => `${fixed(x * 100, 0)}%`;

/** str() of a value of the summary: None, an integer, or a floating-point number written as Python does. */
const written = (x: unknown): string => (typeof x === "number" ? (Number.isInteger(x) && !String(x).includes("e") ? String(x) : floatText(x)) : repr(x));

export function show(s: Summary): string {
  const lines = [`${s.trials} trials on ${s.cases} cases`];
  lines.push(`  success (code): ${percent(s.code_success)}  failures by family: ${repr(s.failures_by_family)}`);
  if (s.judge_success !== undefined) {
    lines.push(`  success (judge): ${percent(s.judge_success)}  to review: ${s.to_review}  “no” by criterion: ${repr(s.no_by_criterion)}`);
    lines.push(`  success (code and judge): ${percent(s.success!)}`);
  }
  lines.push(`  cases passed at every trial: ${s.always_passed_cases}; never: ${s.never_passed_cases}; unstable: ${s.unstable_cases.length}`);
  lines.push("  by type: " + Object.entries(s.by_type).map(([t, v]) => `${t} ${percent(v)}`).join(", "));
  const per = s.cost_per_success ? `$${fixed(s.cost_per_success, 4)}` : "—";
  lines.push(
    `  cost: $${fixed(s.total_cost, 4)} in total, $${fixed(s.average_cost, 4)} per trial, ${per} per success` +
      (s.judge_cost !== undefined ? `; judge: $${fixed(s.judge_cost, 4)}` : ""),
  );
  // The latencies are floating-point numbers in Python: “2.0” and not “2”.
  const latency = (x: number | null): string => (x === null ? "None" : floatText(x));
  lines.push(`  latency: median ${latency(s.median_latency_s)} s, 90% under ${latency(s.latency_p90_s)} s; ${written(s.average_calls)} calls per trial`);
  return lines.join("\n");
}

/** The date in UTC, to the second, like datetime.now(timezone.utc).isoformat(timespec="seconds"). */
export const nowUtc = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

export function registerEntry(folder: string, v: Variant, caseSet: string, cases: EvaluationCase[], trials: number, summary: Summary | Record<string, never>, stopped: boolean): Record<string, unknown> {
  return {
    date: nowUtc(),
    series: basename(folder),
    variant: { ...v },
    versions: versions(v),
    set: caseSet,
    cases_fingerprint: casesFingerprint(cases),
    grading_fingerprint: gradingFingerprint(),
    trials_per_case: trials,
    stopped_by_budget: stopped,
    summary,
  };
}

/** The name of a series, like f"{datetime.now():%Y%m%d-%H%M%S}" (local time). */
export function timestamp(d = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}
