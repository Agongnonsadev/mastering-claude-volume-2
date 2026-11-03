// What imitates Python so that both versions give the same files: round(x, n), repr(float) in the CSV,
// and argparse's options with several values (nargs="+").

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { floatText, writeCsv } from "../comptoir/csv.ts";
import { PYTHON, multipleValues } from "../comptoir/launch.ts";
import { round } from "../comptoir/rounding.ts";

test("round like round: half to even, on the exact value", () => {
  assert.deepEqual([0.5, 1.5, 2.5, -2.5].map((x) => round(x)), [0, 2, 2, -2]);
  assert.equal(round(2.675, 2), 2.67); //  2.67499999… in binary
  assert.equal(round(0.125, 2), 0.12); //  exact in binary: the half goes to even
  assert.equal(round(0.375, 2), 0.38);
  assert.equal(round(5.72, 2), 5.72);
  assert.ok(Object.is(round(-0.4), 0)); // round(x) returns an integer: no “-0”
  // Negative digits round to tens, hundreds…, like round(1250, -2) in Python.
  assert.deepEqual([round(1234, -2), round(1250, -2), round(1350, -2)], [1200, 1200, 1400]);
  assert.throws(() => round(1, 0.5), RangeError);
});

test("a float written as in Python", () => {
  assert.deepEqual([0, 5, 5.72, 0.0001, 0.00001, 2.5e-5, 1e16, 1234567890123456, -0].map(floatText), [
    "0.0", "5.0", "5.72", "0.0001", "1e-05", "2.5e-05", "1e+16", "1234567890123456.0", "-0.0",
  ]);
});

test("the float columns of a results file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "csv-")), "trials.csv");
  writeCsv([{ case: "a", tokens: 12, cost: 0, latency: 3 }], ["case", "tokens", "cost", "latency"], path, ["cost", "latency"]);
  assert.equal(readFileSync(path, "utf8"), "case,tokens,cost,latency\r\na,12,0.0,3.0\r\n");
});

test("an option with several values, like nargs=\"+\"", () => {
  assert.deepEqual(multipleValues(["modes"], ["--modes", "context", "rag", "--max-budget", "0.3"]), [
    "--modes", "context", "--modes", "rag", "--max-budget", "0.3",
  ]);
  assert.deepEqual(multipleValues(["modes"], ["--modes", "rag", "--output", "x.csv"]), ["--modes", "rag", "--output", "x.csv"]);
  // Without a value (nargs="*"): an empty value, in the middle or at the end.
  assert.deepEqual(multipleValues(["traces"], ["--traces", "--max-budget", "1"]), ["--traces=", "--max-budget", "1"]);
  assert.deepEqual(multipleValues(["traces"], ["--max-budget", "1", "--traces"]), ["--max-budget", "1", "--traces="]);
});

// --- Compared with Python ---------------------------------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

test("the same roundings and the same writing as Python, on 3,000 numbers", { skip: PYTHON_VENV ? false : "Python environment missing" }, () => {
  const script = `
import json, random
random.seed(11)
xs = [2.5, 0.125, 0.375, 2.675, 1.25e-05, 1e-07, 123.456, 1e16, 1e22, 0.1 + 0.2]
xs += [random.uniform(-100, 100) for _ in range(300)] + [random.randint(0, 10**6) / 10**random.randint(1, 7) for _ in range(300)]
print(json.dumps({"roundings": [[x, n, round(x, n) if n else round(x)] for x in xs for n in (0, 1, 2, 4, 6)],
                  "reprs": [[x, repr(x)] for x in xs]}))`;
  const python = JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script], { encoding: "utf8" })) as {
    roundings: [number, number, number][];
    reprs: [number, string][];
  };
  assert.ok(python.roundings.length >= 3000);
  for (const [x, n, expected] of python.roundings) assert.equal(round(x, n), expected, `round(${x}, ${n})`);
  for (const [x, expected] of python.reprs) assert.equal(floatText(x), expected, `repr(${x})`);
});
