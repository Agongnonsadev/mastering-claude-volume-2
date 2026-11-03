// Calibrate the judge: compare its verdicts with a human's, on the same answers (chapter 17).
//
// Three figures per criterion:
// - the raw agreement: the share of answers where the judge and the human say the same thing;
// - Cohen's kappa: the same agreement, once the agreement chance alone would give is removed. When almost all
//   the answers are good, a judge that always says “yes” has an excellent raw agreement and a zero kappa: it
//   sees nothing;
// - the false “yes”: the judge lets through an answer the human rejects. That is the error that costs, since
//   a judge is there to catch bad answers.
//
// The human can be wrong too: each disagreement is reread, and settled, before correcting the rubric.

import { fixed } from "../comptoir/rounding.ts";
import { CRITERIA } from "./judge.ts";
import { percent } from "./suite.ts";

export type Grades = Record<string, Record<string, string>>; // {trial ID: {criterion: verdict}}

export class Agreement {
  n = 0;
  agreements = 0;
  kappa: number | null = null;
  readonly false_yes: string[] = []; //  judge yes, human no
  readonly false_no: string[] = []; //   judge no, human yes
  readonly others: string[] = []; //     an “unknown” on one side only

  constructor(readonly criterion: string) {}

  get rawAgreement(): number {
    return this.n ? this.agreements / this.n : 0;
  }
}

function count(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

/** Cohen's kappa for two graders. null if chance is enough to explain everything (a single value). */
export function kappa(pairs: [string, string][]): number | null {
  const n = pairs.length;
  if (!n) return null;
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const left = count(pairs.map(([a]) => a));
  const right = count(pairs.map(([, b]) => b));
  let products = 0;
  for (const v of new Set([...left.keys(), ...right.keys()])) products += (left.get(v) ?? 0) * (right.get(v) ?? 0);
  const expected = products / (n * n);
  if (expected === 1) return null;
  return (observed - expected) / (1 - expected);
}

/** Only the trials graded on both sides count. */
export function compare(human: Grades, judge: Grades): Agreement[] {
  const common = Object.keys(human).filter((t) => t in judge).sort();
  return CRITERIA.map((criterion) => {
    const agreement = new Agreement(criterion);
    const pairs: [string, string][] = [];
    for (const trial of common) {
      const h = human[trial]![criterion];
      const j = judge[trial]![criterion];
      if (h === undefined || j === undefined) continue;
      pairs.push([h, j]);
      agreement.n++;
      if (h === j) agreement.agreements++;
      else if (j === "yes" && h === "no") agreement.false_yes.push(trial);
      else if (j === "no" && h === "yes") agreement.false_no.push(trial);
      else agreement.others.push(trial);
    }
    agreement.kappa = kappa(pairs);
    return agreement;
  });
}

export function outcome(verdicts: Record<string, string>): "passed" | "failed" | "to_review" {
  const v = Object.values(verdicts);
  if (v.includes("no")) return "failed";
  return v.length && v.every((x) => x === "yes") ? "passed" : "to_review";
}

/** On the outcome of each answer (passed, failed, to review): agreements, total, disagreements. */
export function overallAgreement(human: Grades, judge: Grades): [number, number, string[]] {
  const common = Object.keys(human).filter((t) => t in judge).sort();
  const disagreements = common.filter((t) => outcome(human[t]!) !== outcome(judge[t]!));
  return [common.length - disagreements.length, common.length, disagreements];
}

export function show(results: Agreement[]): string {
  const lines = [`${"criterion".padEnd(14)} ${"graded".padStart(6)} ${"agreement".padStart(9)} ${"kappa".padStart(6)} ${"false yes".padStart(9)} ${"false no".padStart(9)}`];
  for (const a of results) {
    const k = a.kappa !== null ? fixed(a.kappa, 2) : "—";
    lines.push(
      `${a.criterion.padEnd(14)} ${String(a.n).padStart(6)} ${percent(a.rawAgreement).padStart(9)} ${k.padStart(6)} ` +
        `${String(a.false_yes.length).padStart(9)} ${String(a.false_no.length).padStart(9)}`,
    );
  }
  return lines.join("\n");
}
