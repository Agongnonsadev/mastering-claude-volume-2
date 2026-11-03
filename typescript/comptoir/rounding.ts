// Python's rounding: to the nearest, half to even (round(2.5) is 2). JavaScript's Math.round rounds
// half up; the calculations that must give the same results as the Python version (image size seen by
// Claude, percentiles of the dashboard, columns of the results files) therefore go through here.

/**
 * |x| rounded to 10^-digits, half to even, on the exact binary value of the number: the number of
 * units of 10^-digits (digits can be negative: tens, hundreds…).
 */
export function roundedUnits(x: number, digits: number): bigint {
  // |x| = mantissa × 2^exponent, exactly, read from the 64 bits of the number.
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const raw = Number((bits >> 52n) & 0x7ffn);
  const mantissa = raw ? (bits & 0xfffffffffffffn) | (1n << 52n) : bits & 0xfffffffffffffn;
  const exponent = raw ? raw - 1075 : -1074;
  let numerator = exponent >= 0 ? mantissa << BigInt(exponent) : mantissa;
  let denominator = exponent >= 0 ? 1n : 1n << BigInt(-exponent);
  if (digits >= 0) numerator *= 10n ** BigInt(digits);
  else denominator *= 10n ** BigInt(-digits);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (2n * remainder > denominator || (2n * remainder === denominator && quotient % 2n === 1n)) quotient += 1n;
  return quotient;
}

/**
 * Python's round(x, digits). The rounding bears on the exact binary value of the number: 2.675 is in
 * fact 2.67499999…, so round(2.675, 2) gives 2.67, as in Python, and 0.125 (exact in binary) gives
 * 0.12, the half going to even.
 */
export function round(x: number, digits = 0): number {
  if (!Number.isInteger(digits)) throw new RangeError(`round: ${digits} digits`);
  if (!Number.isFinite(x) || (digits >= 0 && Number.isInteger(x))) return digits ? x : x + 0;
  const units = roundedUnits(x, digits);
  let text: string;
  if (digits > 0) {
    const figures = units.toString().padStart(digits + 1, "0");
    text = `${figures.slice(0, -digits)}.${figures.slice(-digits)}`;
  } else {
    text = (units * 10n ** BigInt(-digits)).toString();
  }
  const result = x < 0 || Object.is(x, -0) ? -Number(text) : Number(text);
  return digits ? result : result + 0; // round(x) returns an integer, without “-0”
}

/**
 * A number written with n decimals, like f"{x:.nf}" in Python: 1.25 gives “1.2”, the half going to
 * even, where toFixed(1) gives “1.3”. For durations in seconds, often exact halves.
 */
export const fixed = (x: number, digits: number): string => round(x, digits).toFixed(digits);
