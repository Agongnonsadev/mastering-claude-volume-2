// The differences in the format of difflib.unified_diff, and the same output as Python on varied cases.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { splitLines, unifiedDiff } from "../comptoir/diff.ts";
import { PYTHON } from "../comptoir/launch.ts";

test("split into lines like splitlines()", () => {
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
  assert.deepEqual(splitLines("a\r\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\r\nb\rc\n\n", true), ["a\r\n", "b\r", "c\n", "\n"]);
});

test("a unified diff", () => {
  const before = ["Free delivery from 3 bottles.\n", "Payment: Mobile Money.\n", "Closed on Sundays.\n"];
  const after = ["Free delivery from 5 bottles.\n", "Payment: Mobile Money.\n", "Closed on Sundays.\n"];
  assert.equal(
    unifiedDiff(before, after, "faq.md (before)", "faq.md (after)").join(""),
    "--- faq.md (before)\n+++ faq.md (after)\n@@ -1,3 +1,3 @@\n" +
      "-Free delivery from 3 bottles.\n+Free delivery from 5 bottles.\n Payment: Mobile Money.\n Closed on Sundays.\n",
  );
  assert.deepEqual(unifiedDiff(before, before), []); // nothing changed: no line
});

test("without context or line ending, as in chapters 17 and 18", () => {
  assert.deepEqual(unifiedDiff(["a", "b", "c"], ["a", "B", "c", "d"], "", "", { n: 0, lineterm: "" }), [
    "--- ",
    "+++ ",
    "@@ -2 +2 @@",
    "-b",
    "+B",
    "@@ -3,0 +4 @@",
    "+d",
  ]);
});

// --- The same output as difflib ------------------------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

/** Texts drawn at random, but always the same: a generator with a fixed seed. */
function cases(): { a: string[]; b: string[]; n: number }[] {
  let seed = 20261023;
  const rng = (max: number): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % max;
  };
  const words = ["bissap", "ginger", "baobab", "", "Delivery", "Payment", "}", "  "];
  const list: { a: string[]; b: string[]; n: number }[] = [];
  for (let k = 0; k < 60; k++) {
    // A few cases of more than 200 lines, where difflib's autojunk comes into play.
    const length = k % 10 === 9 ? 250 + rng(50) : rng(30);
    const a = Array.from({ length }, () => `${words[rng(words.length)]}\n`);
    const b = [...a];
    for (let m = rng(6); m > 0; m--) {
      const position = rng(b.length + 1);
      const action = rng(3);
      if (action === 0) b.splice(position, 1);
      else if (action === 1) b.splice(position, 0, `${words[rng(words.length)]} ${k}\n`);
      else b[position] = `changed ${m}\n`;
    }
    list.push({ a, b, n: [0, 1, 3, 5][rng(4)]! });
  }
  return list;
}

test("the same output as difflib.unified_diff, on 60 cases", { skip: PYTHON_VENV ? false : "Python environment missing" }, () => {
  const all = cases();
  const script = `
import difflib, json, sys
print(json.dumps([list(difflib.unified_diff(c["a"], c["b"], "before", "after", n=c["n"])) for c in json.load(sys.stdin)], ensure_ascii=False))`;
  const python = JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script], { input: JSON.stringify(all), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }),
  ) as string[][];
  all.forEach((c, k) => assert.deepEqual(unifiedDiff(c.a, c.b, "before", "after", { n: c.n }), python[k], `case ${k}`));
});
