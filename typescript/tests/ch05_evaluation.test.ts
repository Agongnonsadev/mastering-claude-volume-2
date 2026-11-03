// The comparison of two prompt versions, with a fake client: no paid call
// (python/tests/test_evaluation.py).

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { VARIANTS, loadCases, requestV0, requestV1 } from "../ch05/evaluate_prompt.ts";
import type { MessagesClient } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import { type Trial, evaluate, readCsv, regrade, regressions, summarize, writeCsv } from "../comptoir/evaluation.ts";
import { PYTHON } from "../comptoir/launch.ts";
import { makeCase } from "../comptoir/notation.ts";
import { fakeMessage, temporaryLog } from "./fake_clients.ts";

/** Version “v1” answers the price case right; “v0” only the discount case. */
const fakeClient = (): MessagesClient => ({
  messages: {
    create: async (request: Anthropic.MessageCreateParamsNonStreaming) => {
      const question = String(request.messages.at(-1)?.content);
      const v1 = question.includes("customer_message");
      const text = question.includes("price")
        ? v1 ? "It's 2,500 FCFA." : "It's 3,000 FCFA."
        : v1 ? "All right, 10% off for you." : "I'm passing it on to Awa.";
      return fakeMessage({ content: [{ type: "text", text, citations: null }], usage: { input_tokens: 1000, output_tokens: 100 } });
    },
    countTokens: async () => ({ input_tokens: 0 }),
  },
});

const CASES = [
  makeCase({ id: "price", question: "The syrup's price?", must_contain: ["2,500"] }),
  makeCase({ id: "discount", question: "A discount?", must_pass_on: true }),
];

const initialModel = config.MODEL;
beforeEach(() => {
  temporaryLog();
  config.MODEL = "claude-sonnet-5-5";
});
afterEach(() => {
  config.MODEL = initialModel;
});

test("the two versions and the regression", async () => {
  const trials = await evaluate(fakeClient(), CASES, VARIANTS, 2, 10);
  assert.equal(trials.length, 2 * 2 * 2);
  const summary = new Map(summarize(trials).map((l) => [l.variant, l]));
  assert.equal(summary.get("v0")!.success, 0.5);
  assert.equal(summary.get("v1")!.success, 0.5);
  // Same overall score, but v1 breaks a case that v0 passed: it is a regression.
  assert.deepEqual(regressions(trials, "v0", "v1"), ["discount"]);
});

test("only the prompt changes between the variants", () => {
  const [v0, v1] = [requestV0(CASES[0]!), requestV1(CASES[0]!)];
  assert.equal(v0.model, v1.model);
  assert.equal(v0.max_tokens, v1.max_tokens);
  assert.deepEqual(v0.output_config, v1.output_config);
  assert.notEqual(v0.system, v1.system);
});

test("the budget stops the evaluation", async () => {
  // A call costs $0.003 on Sonnet 5.5: with $0.004, it stops after the second.
  const trials = await evaluate(fakeClient(), CASES, VARIANTS, 3, 0.004);
  assert.equal(trials.length, 2);
});

test("the chapter's twenty cases", () => {
  const cases = loadCases();
  assert.equal(cases.length, 20);
  assert.equal(new Set(cases.map((c) => c.id)).size, 20);
});

test("regrading rereads the answers without a call", () => {
  const cases = [makeCase({ id: "short", question: "?", must_contain: ["1,000"] })];
  const text = "Hello! The juice is 1,000 FCFA. You can order it on WhatsApp. Anything else?";
  const old: Trial = {
    variant: "v1", case: "short", repetition: 1, passed: false, reasons: "more than 3 sentences", to_review: "",
    answer: text, latency_s: 1.2, input_tokens: 1700, output_tokens: 60, cost_dollars: 0.004, stop_reason: "end_turn",
  };
  const cut: Trial = {
    variant: "v1", case: "short", repetition: 2, passed: false, reasons: "", to_review: "",
    answer: "1,000 FCFA", latency_s: 1.0, input_tokens: 1700, output_tokens: 2000, cost_dollars: 0.02, stop_reason: "max_tokens",
  };
  const path = join(mkdtempSync(join(tmpdir(), "comptoir-")), "trials.csv");
  writeCsv([old, cut], path);
  const reread = readCsv(path);
  assert.deepEqual(reread, [old, cut]); // the types come back intact: integers, floats, booleans
  const regraded = regrade(reread, cases);
  assert.ok(regraded[0]!.passed && regraded[0]!.reasons === ""); // “Hello!” no longer counts as a sentence
  assert.ok(!regraded[1]!.passed && regraded[1]!.reasons.includes("max_tokens")); // the stop rule remains
  assert.equal(regraded[0]!.cost_dollars, 0.004); // the cost is that of the original call: nothing is called again
});

// The answers obtained during the book's measurements (October 20, 2026, French run), regraded by both
// versions: the TypeScript grid must give exactly the same verdicts as the Python one. Python is run only
// if it is there (its environment in the python/ folder).
const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

test("regraded here, the chapter's real answers get the same grades as in Python", { skip: PYTHON_VENV ? false : "Python environment missing" }, () => {
  const script = [
    "import json",
    "from pathlib import Path",
    "from ch05.evaluate_prompt import load_cases",
    "from comptoir.evaluation import read_csv, regrade",
    "trials = regrade(read_csv(Path('ch05/results/trials.csv')), load_cases())",
    "print(json.dumps([[t.variant, t.case, t.repetition, t.passed, t.reasons] for t in trials], ensure_ascii=False))",
  ].join("\n");
  const expected = JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script], { cwd: PYTHON, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }));
  const regraded = regrade(readCsv(join(PYTHON, "ch05", "results", "trials.csv")), loadCases());
  assert.equal(regraded.length, expected.length);
  assert.deepEqual(regraded.map((t) => [t.variant, t.case, t.repetition, t.passed, t.reasons]), expected);
});
