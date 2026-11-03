// Measure the accuracy of an extractor, field by field, classifying the errors (chapter 7).
//
// Four outcomes for an expected field:
// - “correct”: the right value;
// - “missed”: null when a value was legible. Annoying, but visible: Yao checks;
// - “invented”: a value when null was expected (illegible or missing). The most serious: it cannot be
//   seen;
// - “wrong”: another value than the right one. Serious too, unless a check catches it.

// The fields compared. Free text (remarks, labels) is not graded by the code: it is reread.
export const ORDER_FIELDS = ["customer", "neighborhood", "total_read"];
export const ORDER_LINE_FIELDS = ["product", "quantity", "unit_price_read"];
export const INVOICE_FIELDS = ["supplier", "number", "total_read", "currency"];
export const INVOICE_LINE_FIELDS = ["quantity", "unit_price", "amount"];

export type Outcome = "correct" | "missed" | "invented" | "wrong";
type Value = unknown;
type Document = Record<string, unknown> & { lines?: Record<string, unknown>[] };

/** Case, accents and extra spaces ignored, like casefold() and NFKD in Python. */
function normalize(value: Value): Value {
  if (typeof value !== "string") return value;
  return value.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/\s+/).filter(Boolean).join(" ");
}

const same = (a: Value, b: Value): boolean => {
  const [x, y] = [normalize(a), normalize(b)];
  return x === y || (typeof x === "object" && x !== null && JSON.stringify(x) === JSON.stringify(y));
};

export class Gap {
  constructor(
    readonly document: string,
    readonly field: string,
    readonly expected: Value,
    readonly obtained: Value,
  ) {}

  get outcome(): Outcome {
    if (same(this.expected, this.obtained)) return "correct";
    if (this.obtained === null || this.obtained === undefined) return "missed";
    if (this.expected === null || this.expected === undefined) return "invented";
    return "wrong";
  }
}

const valueOf = (obj: Record<string, unknown> | undefined, field: string): Value => obj?.[field] ?? null;

/** One gap per expected field. A failed extraction (obtained null) misses everything. */
export function compare(document: string, expected: Document, obtained: Document | null, invoice = false): Gap[] {
  const read: Document = obtained ?? {};
  const [fields, lineFields] = invoice ? [INVOICE_FIELDS, INVOICE_LINE_FIELDS] : [ORDER_FIELDS, ORDER_LINE_FIELDS];
  const gaps = fields.map((f) => new Gap(document, f, valueOf(expected, f), valueOf(read, f)));
  const expectedLines = expected.lines ?? [];
  const obtainedLines = read.lines ?? [];
  expectedLines.forEach((line, rank) => {
    const lineRead = obtainedLines[rank] ?? {};
    for (const f of lineFields) gaps.push(new Gap(document, `lines.${rank}.${f}`, valueOf(line, f), valueOf(lineRead, f)));
  });
  // A line read in excess is an invented line.
  for (let rank = expectedLines.length; rank < obtainedLines.length; rank++) {
    gaps.push(new Gap(document, `lines.${rank}`, null, obtainedLines[rank]));
  }
  return gaps;
}

export interface Summary {
  fields: number;
  accuracy: number;
  correct: number;
  missed: number;
  invented: number;
  wrong: number;
}

export function summarize(gaps: Gap[]): Summary {
  const count = (outcome: Outcome) => gaps.filter((g) => g.outcome === outcome).length;
  const total = gaps.length;
  return {
    fields: total,
    accuracy: total ? count("correct") / total : 0,
    correct: count("correct"),
    missed: count("missed"),
    invented: count("invented"),
    wrong: count("wrong"),
  };
}
