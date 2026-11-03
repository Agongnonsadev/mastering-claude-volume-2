// What the TypeScript version imitates from Python to give the same results and the same messages:
// repr() to write a value, == to compare two JSON values, sum() to add floats, json.dumps and
// json.loads, and the :g and repr formats of a float. Rounding (round) is in rounding.ts.

import { roundedUnits } from "./rounding.ts";

/**
 * A Python float, where the way it is written matters: 2.0 is written “2.0” in Python, “2” in JavaScript.
 * It computes like a number (Number(x), or x.value); pythonJson and repr write it as Python does.
 */
export class PyFloat {
  constructor(readonly value: number) {}

  valueOf(): number {
    return this.value;
  }

  toString(): string {
    return floatText(this.value);
  }
}

/** A number read from a JSON file or computed: its value, whether it is a PyFloat or not. */
export const numberOf = (x: unknown): number => Number(x);

/**
 * A number written like repr(float) in Python: the same digits as JavaScript (the shortest that reads
 * back as the same number), but “0.0” for zero, “5.0” for an integer, and scientific notation below
 * 0.0001 (“1e-05”) or from 10^16 (“1e+16”).
 */
export function floatText(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mantissa, power] = x.toExponential().split("e") as [string, string];
  const exponent = Number(power);
  if (exponent < -4 || exponent >= 16) return `${mantissa}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  const text = String(x);
  return text.includes(".") ? text : `${text}.0`;
}

/**
 * f"{x:g}" in Python: six significant digits at most, without useless zeros (2.0 -> “2”, 2.5 ->
 * “2.5”), scientific notation below 0.0001 or from a million. The rounding is Python's (half to even,
 * on the exact value) as long as the number is written without an exponent.
 */
export function formatG(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  // Six significant digits, rounded on the exact value; the exponent is read after rounding, as in
  // Python: 999,999.5 is written “1e+06”, 1,234,565 “1.23456e+06” (half to even).
  let exponent = Number(x.toExponential(5).split("e")[1]);
  let figures = roundedUnits(x, 5 - exponent);
  if (figures >= 1_000_000n) figures = roundedUnits(x, 5 - ++exponent);
  else if (figures < 100_000n) figures = roundedUnits(x, 5 - --exponent);
  const sign = x < 0 ? "-" : "";
  const withoutZeros = (t: string): string => (t.includes(".") ? t.replace(/\.?0+$/, "") : t);
  if (exponent >= -4 && exponent < 6) {
    const decimals = 5 - exponent;
    const text = figures.toString().padStart(decimals + 1, "0");
    return sign + withoutZeros(decimals ? `${text.slice(0, -decimals)}.${text.slice(-decimals)}` : text);
  }
  const text = figures.toString();
  return `${sign}${withoutZeros(`${text[0]}.${text.slice(1)}`)}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
}

/** A value written as Python writes it (repr): None, True, 'text', 2.0, [1, 2], {'key': 'value'}. */
export function repr(v: unknown): string {
  if (v === undefined || v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v instanceof PyFloat) return floatText(v.value);
  if (typeof v === "string") {
    // Double quotes when the text contains an apostrophe (“Awa's juice”), single ones otherwise.
    const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
    const body = v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote;
  }
  if (Array.isArray(v)) return `[${v.map(repr).join(", ")}]`;
  if (typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${repr(k)}: ${repr(x)}`).join(", ")}}`;
  return String(v);
}

/** Python's str(): the text as is, the rest as repr (a float: “2.0”). */
export const str = (v: unknown): string => (typeof v === "string" ? v : repr(v));

/** The equality of two JSON values, like == in Python: same keys, same values, in any order. */
export function equal(a: unknown, b: unknown): boolean {
  if (a instanceof PyFloat || b instanceof PyFloat) return Number(a) === Number(b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Python's sum() over floats: a compensated sum (Neumaier), since Python 3.12. */
export function sum(values: Iterable<number>): number {
  let high = 0;
  let low = 0;
  for (const x of values) {
    const t = high + x;
    low += Math.abs(high) >= Math.abs(x) ? high - t + x : x - t + high;
    high = t;
  }
  return low && Number.isFinite(low) ? high + low : high;
}

/** The whitespace of str.split() in Python (str.isspace): a little more than JavaScript's \s, without the BOM. */
export const WHITESPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/** text.split() in Python: the words, separated by whitespace. */
export const splitWords = (text: string): string[] => text.split(WHITESPACE).filter(Boolean);

type Context = { source?: string };

/** Python's json.loads: a number written with a decimal point or an exponent (“2.0”, “1e3”) stays a PyFloat. */
export const parsePythonJson = (text: string): unknown =>
  JSON.parse(text, (_key, value: unknown, context?: Context) =>
    typeof value === "number" && /[.eE]/.test(context?.source ?? "") ? new PyFloat(value) : value,
  );

/**
 * Python's json.dumps(value, ensure_ascii=False), and with indent: “,” and “:” followed by a space,
 * or one value per line; a PyFloat is written “2.0”. A tool result is the same text, hence the same
 * number of tokens, in both versions.
 */
export function pythonJson(value: unknown, indent: number | null = null, level = 0): string {
  if (value instanceof PyFloat) {
    const v = value.value;
    return Number.isNaN(v) ? "NaN" : Number.isFinite(v) ? floatText(v) : v > 0 ? "Infinity" : "-Infinity";
  }
  const entries: [string | null, unknown][] | null = Array.isArray(value)
    ? value.map((v) => [null, v])
    : value !== null && typeof value === "object"
      ? Object.entries(value)
      : null;
  if (entries === null) return JSON.stringify(value ?? null);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (!entries.length) return open + close;
  const element = ([key, v]: [string | null, unknown]): string =>
    (key === null ? "" : `${JSON.stringify(key)}: `) + pythonJson(v, indent, level + 1);
  if (indent === null) return open + entries.map(element).join(", ") + close;
  const margin = "\n" + " ".repeat(indent * (level + 1));
  return open + margin + entries.map(element).join("," + margin) + "\n" + " ".repeat(indent * level) + close;
}

/** x = mantissa × 2^exponent, exactly, read from the 64 bits of the number (x finite). */
function decompose(x: number): [bigint, number] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const raw = Number((bits >> 52n) & 0x7ffn);
  const mantissa = raw ? (bits & 0xfffffffffffffn) | (1n << 52n) : bits & 0xfffffffffffffn;
  return [bits >> 63n ? -mantissa : mantissa, raw ? raw - 1075 : -1074];
}

const bitLength = (n: bigint): number => (n === 0n ? 0 : n.toString(2).length);

/**
 * p / q × 2^exponent, rounded once to the nearest number (half to even): the division of two Python
 * integers (int / int), exact then rounded, where Number(p) / Number(q) would round twice.
 */
export function divideExactly(p: bigint, q: bigint, exponent = 0): number {
  if (q === 0n) throw new RangeError("division by zero");
  if (p === 0n) return 0;
  const negative = p < 0n !== q < 0n;
  let num = p < 0n ? -p : p;
  let den = q < 0n ? -q : q;
  // A quotient of at least 55 bits: 53 to keep, one for rounding, the rest says whether there is a gap.
  const shift = 55 - (bitLength(num) - bitLength(den));
  if (shift > 0) num <<= BigInt(shift);
  else den <<= BigInt(-shift);
  const quotient = num / den;
  const exact = num % den === 0n;
  let power = exponent - shift;
  let excess = bitLength(quotient) - 53;
  if (power + excess < -1074) excess = -1074 - power; // a subnormal number keeps fewer bits
  let kept = quotient >> BigInt(excess);
  const remainder = quotient & ((1n << BigInt(excess)) - 1n);
  const half = 1n << BigInt(excess - 1);
  if (remainder > half || (remainder === half && (!exact || kept % 2n === 1n))) kept += 1n;
  power += excess;
  // kept × 2^power is representable: two exact multiplications, without overflowing or vanishing on the way.
  const halfPower = Math.trunc(power / 2);
  const result = Number(kept) * 2 ** halfPower * 2 ** (power - halfPower);
  return negative ? -result : result;
}

/**
 * Python's statistics.mean: the exact sum of the numbers, divided by their count, rounded once. JavaScript's
 * sum rounds at each addition: the mean can then differ in the last digit, and the rounding that follows
 * (round(…, 5)) fall on the other side.
 */
export function mean(values: readonly number[]): number {
  if (!values.length) throw new RangeError("mean of an empty list");
  const parts = values.filter((x) => x !== 0).map(decompose);
  if (!parts.length) return 0;
  const smallest = Math.min(...parts.map(([, e]) => e));
  let total = 0n;
  for (const [m, e] of parts) total += m << BigInt(e - smallest);
  return divideExactly(total, BigInt(values.length), smallest);
}

/** Python's statistics.median: the middle value, or the mean of the two middle ones. */
export function median(values: readonly number[]): number {
  if (!values.length) throw new RangeError("median of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
