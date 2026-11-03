// Chapter 17: draw the answers a human will grade, then calibrate the judge on their grades.
//
// From the typescript/ folder (free: no call):
//     npx tsx ch17/sample.ts draw <series> --size 30
//     npx tsx ch17/sample.ts page [--complement results/sample-haiku.json]   (results/to_grade.html)
//     npx tsx ch17/sample.ts calibrate <series> --model claude-haiku-5-5 [--half calibration]
//
// The page keeps the grades in the browser; a button downloads them as human_grades.json, to put in
// ch17/results/.
//
// The sample takes a single trial per case, to see as many cases as possible, and respects the share of each
// type (common, trap, security). It is cut into two halves: the judge's rubric is corrected by looking at the
// “calibration” half, and the corrected rubric is checked on the “control” half, which was not looked at.
// Otherwise, the rubric gets fitted to those very answers.
//
// The human grades blind, without seeing the judge's verdicts, with the same information as the judge: the
// message, the answer, the summary, what the system did, the reference, and the documents. Their grades go
// into results/human_grades.json: {trial: {criterion: verdict}}.
//
// The draw is the Python version's (the same generator, the same seed): on the same series, both versions
// draw the same answers. The grading page is that of python/ch17/.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { isMain } from "../comptoir/launch.ts";
import { pythonJson } from "../comptoir/python.ts";
import { PythonRandom } from "../comptoir/random.ts";
import { round } from "../comptoir/rounding.ts";
import * as calibration from "./calibration.ts";
import { type EvaluationCase, type Trial, identifier } from "./harness.ts";
import { CRITERIA, RUBRIC, actions, documents } from "./judge.ts";
import { DATA, FOLDER as CHAPTER_FOLDER, loadCases, readJudgments, readSeries, readText } from "./suite.ts";

export const FOLDER = join(CHAPTER_FOLDER, "results");
export const SAMPLE = join(FOLDER, "sample.json");
export const GRADES = join(FOLDER, "human_grades.json");
export const PAGE = join(DATA, "grading_page.html");
export const TYPES = ["common", "trap", "security"];

export interface Card {
  trial: string;
  case: string;
  type: string;
  message: string;
  answer: string;
  summary: string;
  actions: string;
  reference: string;
}

export interface Sample {
  trials: string[];
  halves: { calibration: string[]; control: string[] };
  criteria: string[];
  cards: Card[];
  series?: string;
  complement?: string[];
}

export function draw(trials: Trial[], cases: EvaluationCase[], size: number, seed = 17): Sample {
  const rng = new PythonRandom(seed);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const byCase = new Map<string, Trial[]>();
  for (const t of trials) byCase.set(t.case, [...(byCase.get(t.case) ?? []), t]);
  const kept: Trial[] = [];
  for (const kind of TYPES) {
    const candidates = [...byCase.keys()].filter((c) => byId.get(c)!.type === kind).sort();
    const share = round((size * candidates.length) / byCase.size);
    for (const c of rng.sample(candidates, Math.min(share, candidates.length))) kept.push(rng.choice(byCase.get(c)!));
  }
  rng.shuffle(kept);
  const half = Math.floor(kept.length / 2);
  const cards = kept.map((t): Card => ({
    trial: identifier(t),
    case: t.case,
    type: byId.get(t.case)!.type,
    message: byId.get(t.case)!.message,
    answer: t.claude_text,
    summary: t.text.slice(t.claude_text.length).trim(),
    actions: actions(t),
    reference: byId.get(t.case)!.reference,
  }));
  return {
    trials: kept.map(identifier),
    halves: { calibration: kept.slice(0, half).map(identifier), control: kept.slice(half).map(identifier) },
    criteria: [...CRITERIA],
    cards,
  };
}

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pythonJson(value, 1), "utf8"); // json.dumps(…, ensure_ascii=False, indent=1)
};

function cmdDraw(series: string, size: number, output: string | undefined): void {
  const sample = draw(readSeries(series), loadCases(), size);
  sample.series = basename(series);
  const path = output ?? SAMPLE;
  writeJson(path, sample);
  const types = sample.cards.map((c) => c.type);
  console.log(`${types.length} answers: ` + TYPES.map((t) => `${t} ${types.filter((x) => x === t).length}`).join(", ") + ` → ${path}`);
}

/** The grading page, filled in: the cards in the order of the draw, without any verdict from the judge. */
export function pageContent(sample: Pick<Sample, "criteria" | "cards">): string {
  const data = {
    criteria: sample.criteria,
    cards: sample.cards,
    documents: documents().replaceAll("<documents>", "").replaceAll("</documents>", "").trim(),
  };
  // “</” would close the <script> tag that carries the data.
  const json = pythonJson(data).replaceAll("</", "<\\/");
  return readText(PAGE).replaceAll("__DATA__", () => json);
}

/**
 * A few answers from another variant, on the same cases, so that a human judges it too. Same share of each
 * type as the sample; nothing on the card says which model answered.
 */
export function complement(cards: Card[], number: number, seed = 1717): Card[] {
  const rng = new PythonRandom(seed);
  const byType = new Map<string, Card[]>();
  for (const c of cards) byType.set(c.type, [...(byType.get(c.type) ?? []), c]);
  const kept: Card[] = [];
  for (const kind of TYPES) {
    const group = byType.get(kind) ?? [];
    const share = round((number * group.length) / cards.length);
    kept.push(...rng.sample([...group].sort((a, b) => (a.trial < b.trial ? -1 : a.trial > b.trial ? 1 : 0)), share));
  }
  rng.shuffle(kept);
  return kept;
}

function cmdPage(noSkeleton: string | undefined, complementOf: string | undefined, number: number): void {
  let sample = JSON.parse(readFileSync(SAMPLE, "utf8")) as Sample;
  if (complementOf) {
    const added = complement((JSON.parse(readFileSync(complementOf, "utf8")) as Sample).cards, number);
    sample.complement = added.map((c) => c.trial);
    writeJson(SAMPLE, sample);
    sample = { ...sample, cards: [...sample.cards, ...added] };
  }
  const content = pageContent(sample);
  const output = join(FOLDER, "to_grade.html");
  writeFileSync(
    output,
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head>' +
      `<body>\n${content}\n</body></html>\n`,
    "utf8",
  );
  if (noSkeleton) writeFileSync(noSkeleton, content, "utf8");
  console.log(`Grading page: ${output}`);
}

function cmdCalibrate(series: string, model: string, rubric: string, half: string): void {
  const sample = JSON.parse(readFileSync(SAMPLE, "utf8")) as Sample;
  const grades = JSON.parse(readFileSync(GRADES, "utf8")) as Record<string, Record<string, string>>;
  const kept = new Set(
    half === "complement"
      ? (sample.complement ?? []) // the other variant's answers: pass its series
      : half === "all"
        ? sample.trials
        : sample.halves[half as "calibration" | "control"],
  );
  const human: calibration.Grades = Object.fromEntries(
    Object.entries(grades)
      .filter(([t]) => kept.has(t))
      .map(([t, g]) => [t, Object.fromEntries(Object.entries(g).filter(([c]) => (CRITERIA as readonly string[]).includes(c)))]),
  );
  const judgments = readJudgments(series, model, rubric);
  const judge: calibration.Grades = Object.fromEntries(
    Object.entries(judgments).filter(([t, j]) => kept.has(t) && j.verdicts && Object.keys(j.verdicts).length).map(([t, j]) => [t, j.verdicts]),
  );
  const results = calibration.compare(human, judge);
  console.log(`Judge ${model} (rubric ${rubric}), half “${half}”: ${Object.keys(human).filter((t) => t in judge).length} answers graded on both sides\n`);
  console.log(calibration.show(results));
  const [agreements, total] = calibration.overallAgreement(human, judge);
  console.log(`\nSame outcome (passed, failed, to review): ${agreements} out of ${total}`);
  let cards = new Map(sample.cards.map((c) => [c.trial, c]));
  if (half === "complement") {
    // “haiku” in 20261021-184109-haiku-improvement
    const name = basename(series).split("-").slice(2).join("-");
    const other = name.slice(0, name.lastIndexOf("-") === -1 ? undefined : name.lastIndexOf("-"));
    const path = join(FOLDER, `sample-${other}.json`);
    if (existsSync(path)) {
      cards = new Map([...cards, ...(JSON.parse(readFileSync(path, "utf8")) as Sample).cards.map((c): [string, Card] => [c.trial, c])]);
    }
  }
  for (const a of results) {
    for (const trial of [...a.false_yes, ...a.false_no, ...a.others]) {
      console.log(`\n[${a.criterion}] ${trial}: human ${human[trial]![a.criterion]}, judge ${judge[trial]![a.criterion]}`);
      console.log(`  message: ${cards.get(trial)!.message}\n  answer: ${cards.get(trial)!.answer}`);
      console.log(`  the judge's finding: ${judgments[trial]!.findings![a.criterion]}`);
    }
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const { values: args, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      size: { type: "string", default: "30" },
      output: { type: "string" }, //          a file other than results/sample.json (same draw)
      "no-skeleton": { type: "string" }, //   also write the page without <html> or <head>, to publish it
      complement: { type: "string" }, //      a sample of another variant, from which to add a few answers
      number: { type: "string", default: "10" },
      model: { type: "string", default: "claude-haiku-5-5" },
      rubric: { type: "string", default: RUBRIC },
      half: { type: "string", default: "calibration" },
    },
  });
  if (command === "draw") cmdDraw(positionals[0]!, Number(args.size), args.output);
  else if (command === "page") cmdPage(args["no-skeleton"], args.complement, Number(args.number));
  else if (command === "calibrate") {
    if (!["calibration", "control", "all", "complement"].includes(args.half)) throw new Error("--half: calibration, control, all or complement");
    cmdCalibrate(positionals[0]!, args.model, args.rubric, args.half);
  } else throw new Error("Command: draw, page or calibrate.");
}

if (isMain(import.meta.url)) main();
