// Chapter 17: compare two series of trials, case by case, and say whether the gap goes beyond chance.
//
// Run, from the typescript/ folder (free: no call):
//     npx tsx ch17/compare.ts <series A> <series B> [--judge-model claude-haiku-5-5]
//
// Three precautions:
// - the two series must have received the same messages (the cases' fingerprint, in the register); they are
//   graded here by the same grading, the grading of the day;
// - the comparison is case by case: a case won, a case lost, and not an average;
// - the sign test says whether a majority of cases moving in the same direction can come from chance. It
//   proves nothing on one or two cases: more trials, or more cases, are then needed.
//
// A series of the Python version compares too: the files have the same shape.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMain } from "../comptoir/launch.ts";
import { divideExactly, repr } from "../comptoir/python.ts";
import { fixed } from "../comptoir/rounding.ts";
import { RUBRIC } from "./judge.ts";
import { loadCases, locations, ratePerCase, readJudgments, readSeries, show, summarize } from "./suite.ts";

/** Combinations of k among n, exactly. */
function combinations(n: number, k: number): bigint {
  let c = 1n;
  for (let i = 0; i < k; i++) c = (c * BigInt(n - i)) / BigInt(i + 1);
  return c;
}

/** Probability of a gap at least as clear if the two versions were equal (two-sided). */
export function signTest(won: number, lost: number): number {
  const n = won + lost;
  if (n === 0) return 1;
  const k = Math.min(won, lost);
  let total = 0n;
  for (let i = 0; i <= k; i++) total += combinations(n, i);
  return Math.min(1, divideExactly(2n * total, 2n ** BigInt(n))); // an integer divided by an integer, as in Python
}

/**
 * The series' line in the register: the one next to the series (results/register.jsonl, for
 * results/series/<series>), then this version's. A series of the Python version thus keeps its versions.
 */
export function entry(series: string): Record<string, unknown> | null {
  for (const register of new Set([join(dirname(dirname(resolve(series))), "register.jsonl"), locations.register])) {
    if (!existsSync(register)) continue;
    const lines = readFileSync(register, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    const line = lines.reverse().find((l) => l.series === basename(series));
    if (line) return line;
  }
  return null;
}

/** The cases B passes more often, and those A passes more often. */
export function compare(a: Record<string, number>, b: Record<string, number>): [string[], string[]] {
  const common = Object.keys(a).filter((c) => c in b).sort();
  return [common.filter((c) => b[c]! > a[c]!), common.filter((c) => b[c]! < a[c]!)];
}

function main(): void {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: { "judge-model": { type: "string" }, rubric: { type: "string", default: RUBRIC } },
  });
  if (positionals.length !== 2) throw new Error("Two series to compare: <series A> <series B>.");
  const cases = loadCases();
  const series = positionals;
  const infos = series.map(entry);
  if (infos[0] && infos[1]) {
    for (const key of ["cases_fingerprint", "set"]) {
      if (infos[0][key] !== infos[1][key]) {
        console.error(`Series not comparable: different ${key} (${infos[0][key]} / ${infos[1][key]}).`);
        process.exit(1);
      }
    }
  }
  const rates = series.map((s, i) => {
    const trials = readSeries(s);
    const judgments = args["judge-model"] ? readJudgments(s, args["judge-model"], args.rubric) : null;
    console.log(`\n${basename(s)}` + (infos[i] ? ` — ${repr(infos[i]!.versions)}` : ""));
    console.log(show(summarize(trials, cases, judgments)));
    return ratePerCase(trials, cases, judgments);
  });
  const [won, lost] = compare(rates[0]!, rates[1]!);
  console.log(`\nCases B passes more often: ${won.length} ${repr(won)}`);
  console.log(`Cases A passes more often: ${lost.length} ${repr(lost)}`);
  console.log(`Sign test: p = ${fixed(signTest(won.length, lost.length), 2)} (below 0.05, the gap is unlikely to come from chance)`);
}

if (isMain(import.meta.url)) main();
