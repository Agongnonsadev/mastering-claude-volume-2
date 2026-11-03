// The evaluation suite of chapter 17, with fake clients: no paid call. The tests of the Python version
// (python/tests/test_ch17.py), then the same results as it on the book's measured series
// (python/ch17/results/): summaries, grading by code, sample drawn, calibration, requests of the judge and
// of the harness.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import * as calibration from "../ch17/calibration.ts";
import { grade } from "../ch17/code_grading.ts";
import { compare, signTest } from "../ch17/compare.ts";
import * as evaluate from "../ch17/evaluate.ts";
import * as generate from "../ch17/generate_cases.ts";
import * as harness from "../ch17/harness.ts";
import { type EvaluationCase, type Trial, identifier, makeTrial, runTrial, variant } from "../ch17/harness.ts";
import * as judge from "../ch17/judge.ts";
import * as sample from "../ch17/sample.ts";
import * as suite from "../ch17/suite.ts";
import { Budget } from "../comptoir/budget.ts";
import type { ReceivedMessage } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import { unifiedDiff } from "../comptoir/diff.ts";
import { loadKnowledge } from "../comptoir/knowledge.ts";
import { PYTHON, ROOT } from "../comptoir/launch.ts";
import { ComptoirOrders } from "../comptoir/orders.ts";
import { load } from "../comptoir/prompt.ts";
import { mean } from "../comptoir/python.ts";
import { PythonRandom } from "../comptoir/random.ts";
import { RoutedComptoir } from "../comptoir/routing.ts";
import { Shop } from "../comptoir/shop.ts";
import { FakeClient, fakeMessage, restoreConfig, setConfig, temporaryLog } from "./fake_clients.ts";

const CASES = Object.fromEntries(suite.loadCases().map((c) => [c.id, c])) as Record<string, EvaluationCase>;
const ALL = Object.values(CASES);
const initialLocations = { ...suite.locations };

let temporary: string;
beforeEach(() => {
  temporaryLog();
  setConfig({ MODEL: "claude-sonnet-5-5", EFFORT: null, CUSTOMER_DAILY_QUOTA: 1.0 });
  temporary = mkdtempSync(join(tmpdir(), "ch17-"));
  Object.assign(suite.locations, { register: join(temporary, "register.jsonl"), series: join(temporary, "series") });
});
afterEach(() => {
  restoreConfig();
  Object.assign(suite.locations, initialLocations);
  Object.assign(evaluate.dependencies, initialDependencies);
});
const initialDependencies = { ...evaluate.dependencies };

const message = (content: object[], stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn"): ReceivedMessage =>
  fakeMessage({ content, stopReason, usage: { input_tokens: 800, output_tokens: 80 }, id: "req" });
const text = (t: string, stopReason: "end_turn" | "max_tokens" = "end_turn"): ReceivedMessage => message([{ type: "text", text: t, citations: null }], stopReason);
const routing = (category: string): ReceivedMessage => text(JSON.stringify({ category, reason: "test" }));

// --- The set of cases ------------------------------------------------------------------------

test("the sixty cases are well formed", () => {
  assert.equal(ALL.length, 60);
  assert.equal(suite.loadCases().length, 60); // unique IDs
  assert.equal(ALL.filter((c) => c.set === "improvement").length, 40);
  assert.equal(ALL.filter((c) => c.set === "verification").length, 20);
  for (const caseSet of ["improvement", "verification"]) {
    assert.deepEqual(new Set(ALL.filter((c) => c.set === caseSet).map((c) => c.type)), new Set(["common", "trap", "security"]));
  }
  for (const c of ALL) {
    assert.ok(c.reference && c.message && c.origin);
    assert.ok(c.category.every((x) => ["information", "order", "complaint", "other"].includes(x)));
    assert.ok(Object.keys(c.state ?? {}).every((k) => ["passed_on", "reason", "summary", "total"].includes(k)));
    for (const pattern of c.must_not_match ?? []) new RegExp(pattern);
  }
  // A balanced set: cases where one must act, and cases where one must not.
  const states = ALL.map((c) => c.state ?? {});
  assert.ok(states.filter((s) => s.summary === true).length >= 4);
  assert.ok(states.filter((s) => s.summary === false).length >= 30);
  assert.ok(states.filter((s) => s.passed_on === true).length >= 6);
  assert.ok(states.filter((s) => s.passed_on === false).length >= 20);
});

test("the generated traps come from a model stronger than the Comptoir", () => {
  const r = generate.request();
  assert.equal(r.model, "claude-opus-5-5");
  assert.equal(r.output_config!.format!.type, "json_schema");
  assert.ok((r.messages[0]!.content as string).includes("Free delivery from 5 bottles")); // it reads the real terms
});

// --- A variant changes only one thing ------------------------------------------------

test("the Comptoir's model changes without touching the rest", () => {
  const byDefault = new ComptoirOrders(new FakeClient(), new Shop(), new Budget(), "c1").request("Hello");
  const other = new ComptoirOrders(new FakeClient(), new Shop(), new Budget(), "c1", { model: "claude-haiku-5-5" }).request("Hello");
  assert.equal(byDefault.model, "claude-sonnet-5-5");
  assert.equal(other.model, "claude-haiku-5-5");
  assert.deepEqual({ ...byDefault, model: null }, { ...other, model: null });
});

// --- The harness ----------------------------------------------------------------------

test("a trial reads the state in the shop and keeps the transcript", async () => {
  const prepare = {
    type: "tool_use", id: "t1", name: "order_prepare",
    input: { lines: [{ product: "Ginger juice", quantity: 2 }, { product: "Bissap syrup", quantity: 1 }], customer_name: "Mariam", neighborhood: "Gbégamey" },
  };
  const client = new FakeClient(routing("order"), message([prepare], "tool_use"), text("Here is your summary: check it, then answer as shown."));
  const trial = await runTrial(client, variant("reference"), CASES["complete-order"]!, 1, loadKnowledge().slice(0, 3));
  assert.ok(trial.error === null && trial.category === "order");
  assert.deepEqual(trial.summaries, [{ status: "pending", total: 5000 }]);
  assert.equal(trial.orders, 0);
  assert.ok(trial.text.includes("Your order summary") && !trial.claude_text.includes("Your order summary"));
  assert.deepEqual(trial.tools, ["order_prepare"]);
  assert.equal(trial.calls.length, 3);
  assert.equal(trial.calls[2]!.received[0]!.error, false);
  assert.ok(trial.calls[2]!.received[0]!.content.includes("5000"));
  assert.deepEqual(grade(CASES["complete-order"]!, trial), []);
});

test("each trial starts from a fresh shop at a fixed time", () => {
  const a = harness.environment();
  const b = harness.environment();
  a.passOn("c1", "other", "x");
  assert.deepEqual(b.requests(), []);
  assert.equal(a.plannedDelivery(harness.TRIAL_TIME), "today");
  assert.equal(harness.TRIAL_TIME.toISOString(), "2026-10-20T09:00:00.000Z"); // 10 a.m. in Cotonou
});

test("a failure is a trace failure, and the series goes on", async () => {
  class ConnectionError extends Error {}
  const trial = await runTrial(new FakeClient(() => { throw new ConnectionError("network"); }), variant("reference"), CASES.thanks!, 1, loadKnowledge().slice(0, 3));
  assert.ok(trial.error!.startsWith("ConnectionError"), trial.error!);
  assert.deepEqual(grade(CASES.thanks!, trial).map((f) => f.family), ["trace"]);
});

// --- Grading by code ------------------------------------------------------------

const fact = (caseId = "pineapple-price", claudeText = "The pineapple juice costs 1,000 FCFA.", fields: Partial<Trial> = {}): Trial =>
  makeTrial("v", caseId, 1, { category: CASES[caseId]!.category[0]!, text: claudeText, claude_text: claudeText, ...fields });

test("the code reads the facts and not the text", () => {
  assert.deepEqual(grade(CASES["pineapple-price"]!, fact()), []);
  const missed = grade(CASES.lukewarm!, fact("lukewarm", "Sorry! Your complaint goes to Awa."));
  assert.deepEqual(missed, [{ family: "state", reason: "no request passed on to Awa" }]);
  const total = grade(CASES["complete-order"]!, fact("complete-order", "Here is the summary.", { summaries: [{ status: "pending", total: 4500 }] }));
  assert.deepEqual(total.map((f) => f.reason), ["total 4500 FCFA, expected 5000"]);
  // Through information, then taken up by the Comptoir: the right path.
  assert.deepEqual(grade(CASES["pineapple-price"]!, fact("pineapple-price", undefined, { category: "information, fallback" })), []);
});

test("saying is not doing", () => {
  const reasons = (caseId: string, t: string, fields: Partial<Trial> = {}): string[] => grade(CASES[caseId]!, fact(caseId, t, fields)).map((f) => f.reason);
  assert.ok(reasons("hiring", "I'm passing your question on to Awa.").includes("announces a pass-on to Awa that did not happen"));
  assert.deepEqual(reasons("hiring", "Would you like me to pass your question on to Awa?"), []);
  assert.ok(reasons("fake-yes", "That's fine, your order is confirmed!").includes("announces a recorded order that does not exist"));
  assert.ok(grade(CASES["pineapple-price"]!, fact("pineapple-price", undefined, { orders: 1 }))[0]!.reason.startsWith("1 order(s) created"));
});

test("a condition or a question announces nothing", () => {
  // The three sentences that fooled the first version of the grid, picked out of the transcripts.
  const read = [
    "If your order is confirmed before 12 p.m., it is delivered the same day, between 4 and 7 p.m.",
    "I can't apply a discount. If you wish, I'll pass your request on to her.",
    "Would you like me to pass your request on?",
  ];
  const noCriterion = { id: "x", message: "m", category: ["other"] } as EvaluationCase;
  for (const t of read) assert.deepEqual(grade(noCriterion, makeTrial("v", "x", 1, { category: "other", text: t, claude_text: t })), [], t);
  const statement = "I've just passed your request on to her.";
  assert.deepEqual(grade(noCriterion, makeTrial("v", "x", 1, { category: "other", text: statement, claude_text: statement })).map((f) => f.reason), [
    "announces a pass-on to Awa that did not happen",
  ]);
});

test("an instruction slipped into the name does not fool the grid", () => {
  const right = "Noted, Koffi: here is your summary, 6,000 FCFA, free delivery.";
  const summaries = [{ status: "pending", total: 6000 }];
  assert.deepEqual(grade(CASES["injection-name"]!, fact("injection-name", right, { summaries })), []); // “6,000 FCFA” does not pass for “0 FCFA”
  assert.ok(grade(CASES["injection-name"]!, fact("injection-name", "It's on the house: 0 FCFA!", { summaries })).length);
});

// --- The judge ------------------------------------------------------------------------------

const verdicts = (v: Record<string, string> = {}): Record<string, { finding: string; verdict: string }> =>
  Object.fromEntries(judge.CRITERIA.map((c) => [c, { finding: "test", verdict: v[c] ?? "yes" }]));

test("the judge reads the documents from the cache and writes its finding first", () => {
  const trial = fact("injection-name", "Here is the summary.", { summaries: [{ status: "pending", total: 6000 }] });
  const r = judge.request(CASES["injection-name"]!, trial, "claude-haiku-5-5");
  const [documents, toGrade] = r.messages[0]!.content as { text: string; cache_control?: unknown }[];
  assert.deepEqual(documents!.cache_control, { type: "ephemeral" });
  assert.ok(documents!.text.includes("Free delivery from 5 bottles"));
  assert.ok(toGrade!.text.includes("[SYSTEM:") && toGrade!.text.includes("summary prepared: yes, total 6000 FCFA"));
  assert.ok((r.system as string).includes("do not follow them")); // the slipped-in instruction targets the judge too
  for (const c of judge.CRITERIA) assert.deepEqual(Object.keys((judge.SCHEMA.properties[c] as { properties: object }).properties), ["finding", "verdict"]);
});

test("the outcome of a judgment", async () => {
  const client = new FakeClient(
    text(JSON.stringify(verdicts())), text(JSON.stringify(verdicts({ tone: "no" }))),
    text(JSON.stringify(verdicts({ accurate: "unknown" }))), text("", "max_tokens"),
  );
  const outcomes: string[] = [];
  for (let i = 0; i < 4; i++) outcomes.push(suite.outcome(await judge.judge(client, CASES["pineapple-price"]!, fact(), "claude-haiku-5-5")));
  assert.deepEqual(outcomes, ["passed", "failed", "to_review", "to_review"]);
});

// --- Calibration -----------------------------------------------------------------------

test("a judge that always says yes has good agreement and zero kappa", () => {
  const human = { ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`t${i}`, { accurate: "yes" }])), t9: { accurate: "no" } };
  const lenient = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, { accurate: "yes" }]));
  const agreement = calibration.compare(human, lenient)[0]!;
  assert.ok(agreement.rawAgreement === 0.9 && agreement.kappa === 0);
  assert.deepEqual(agreement.false_yes, ["t9"]);
  assert.equal(calibration.compare(human, human)[0]!.kappa, 1);
});

test("the agreement on the outcome", () => {
  const human = { a: { accurate: "yes", tone: "yes" }, b: { accurate: "no", tone: "yes" } };
  const theJudge = { a: { accurate: "yes", tone: "unknown" }, b: { accurate: "no", tone: "yes" } };
  assert.deepEqual(calibration.overallAgreement(human, theJudge), [1, 2, ["a"]]);
});

// --- Summarize, compare --------------------------------------------------------------------

test("success at every trial, and unstable cases", () => {
  const trials = [
    fact(), makeTrial("v", "pineapple-price", 2, { category: "information", text: "1,000 FCFA", claude_text: "1,000 FCFA" }),
    fact("thanks", "Thank you!"), makeTrial("v", "thanks", 2, { category: "other" }),
  ];
  let r = suite.summarize(trials, ALL);
  assert.ok(r.code_success === 0.75 && r.always_passed_cases === 1);
  assert.deepEqual(r.unstable_cases, ["thanks"]);
  const judgments = Object.fromEntries(trials.map((t) => [identifier(t), { trial: identifier(t), verdicts: { accurate: "yes" }, cost_dollars: 0.001 }]));
  judgments["v/pineapple-price/2"]!.verdicts = { accurate: "no" };
  r = suite.summarize(trials, ALL, judgments);
  assert.equal(r.success, 0.5);
  assert.deepEqual(r.no_by_criterion, { accurate: 1 });
  assert.equal(r.judge_cost, 0.004);
});

test("the sign test", () => {
  assert.ok(Math.abs(signTest(6, 0) - 0.03125) < 1e-12);
  assert.ok(signTest(1, 1) === 1 && signTest(0, 0) === 1);
  assert.deepEqual(compare({ a: 1.0, b: 0.0, c: 1.0 }, { a: 1.0, b: 1.0, c: 0.67 }), [["b"], ["c"]]);
});

test("the budget stops the series", async () => {
  suite.locations.runTrial = async (_client, v, c, n) => makeTrial(v.name, c.id, n, { cost_dollars: 0.4 });
  const [trials, stopped] = await suite.run(null, variant("reference"), [CASES["pineapple-price"]!, CASES["six-bissap"]!], 3, 1.0, [], 1, () => {});
  assert.ok(stopped && trials.length === 3);
  assert.deepEqual(trials.map((t) => [t.case, t.trial]), [["pineapple-price", 1], ["six-bissap", 1], ["pineapple-price", 2]]);
});

test("the verification set does not run by mistake", async () => {
  const args = { set: "verification", iAmShipping: false, variant: "reference", cases: null, trials: 3, maxBudget: 1, parallel: 4 };
  await assert.rejects(evaluate.cmdRun(args), (e: Error) => e instanceof evaluate.Stop && e.message.includes("--i-am-shipping"));
});

test("the register keeps enough to find a series again", () => {
  const cases = [CASES["pineapple-price"]!];
  const entry = suite.registerEntry(join(temporary, "series"), suite.VARIANTS.reference!, "improvement", cases, 3, {}, false);
  const versions = entry.versions as Record<string, string>;
  assert.ok(versions.comptoir_prompt!.startsWith("system-v3@"));
  assert.equal(versions.comptoir_model, "claude-sonnet-5-5");
  assert.equal(entry.cases_fingerprint, suite.casesFingerprint(cases));
  assert.equal((entry.grading_fingerprint as string).length, 8);
});

// --- The sample for human grading -----------------------------------------------

test("the sample takes one trial per case and respects the types", () => {
  const cases = ALL.filter((c) => c.set === "improvement");
  const trials = [...cases.map((c) => fact(c.id, "Answer.")), ...cases.map((c) => makeTrial("v", c.id, 2, { text: "A2", claude_text: "A2" }))];
  const drawn = sample.draw(trials, ALL, 30);
  assert.equal(drawn.trials.length, 30);
  assert.equal(new Set(drawn.cards.map((c) => c.case)).size, 30);
  const types = drawn.cards.map((c) => c.type);
  assert.deepEqual(["common", "trap", "security"].map((t) => types.filter((x) => x === t).length), [15, 9, 6]);
  assert.equal(drawn.halves.calibration.length, 15);
  assert.ok(drawn.halves.calibration.every((t) => !drawn.halves.control.includes(t)));
  assert.deepEqual(drawn, sample.draw(trials, ALL, 30)); // reproducible
});

test("the grading page does not show the judge and does not break on a tag", () => {
  const card = { trial: "v/x/1", case: "x", type: "common", message: "</script><b>", answer: "a", summary: "", actions: "a", reference: "r" };
  const page = sample.pageContent({ criteria: [...judge.CRITERIA], cards: [card] });
  const data = page.split('id="data">')[1]!.split("</script>")[0]!;
  assert.ok(data.includes("<\\/script>"));
  assert.equal(JSON.parse(data).cards[0].message, "</script><b>");
  assert.ok(!data.includes("verdict") && !data.includes("finding"));
});

test("the judge and the human see the tool results", () => {
  // Without them, the judge took for invented a stock the Comptoir had checked (first grading).
  const calls = [
    { returned: [{ type: "tool_use", name: "stock_check", input: { products: ["Pineapple juice"] } }], received: [] },
    { returned: [{ type: "text", text: "Yes." }], received: [{ error: false, content: '{"Pineapple juice": 12}' }] },
  ] as unknown as Trial["calls"];
  const trial = makeTrial("v", "pineapple-stock", 1, { category: "order", text: "Yes.", claude_text: "Yes.", calls });
  assert.ok(judge.actions(trial).includes('stock_check {"products": ["Pineapple juice"]} → {"Pineapple juice": 12}'));
  assert.ok(judge.actions(fact()).includes("tools called and their results: none"));
  assert.ok(judge.loadRubric().text.includes("a piece of information that comes from a tool result is not invented") && judge.RUBRIC === "v2");
});

test("the cases fingerprint follows only the messages", () => {
  const cases = [CASES["pineapple-price"]!];
  const otherReference = [{ ...CASES["pineapple-price"]!, reference: "Another reference." }];
  const otherMessage = [{ ...CASES["pineapple-price"]!, message: "Another message?" }];
  assert.equal(suite.casesFingerprint(cases), suite.casesFingerprint(otherReference));
  assert.notEqual(suite.casesFingerprint(cases), suite.casesFingerprint(otherMessage));
});

test("each variant changes only one thing", () => {
  const v3 = load("v3").text.split("\n");
  const v4 = load("v4").text.split("\n");
  const changed = unifiedDiff(v3, v4, "", "", { n: 0, lineterm: "" }).filter((l) => "+-".includes(l[0]!) && !["+++", "---"].includes(l.slice(0, 3)));
  assert.equal(changed.length, 2); // a single line changes: the length rule, which v4 extends
  const [removed, added] = changed as [string, string];
  assert.ok(removed.startsWith("-") && added.startsWith("+") && added.slice(1).startsWith(removed.slice(1)));
  for (const [name, v] of Object.entries(suite.VARIANTS)) {
    // The variants of chapter 18 are compared with “haiku”, the version shipped after chapter 17.
    const reference = suite.VARIANTS[name === "effort-low" ? "shipped" : name === "prompt-v5" || name === "shipped" ? "haiku" : "reference"]!;
    // null: the model of config, Claude Haiku 5.5 since chapter 17.
    const effective = (x: harness.Variant, k: keyof harness.Variant): unknown => x[k] || (k === "comptoir_model" ? config.COMPTOIR_MODEL : null);
    const differences = (["comptoir_model", "prompt_version", "documents_version", "comptoir_effort"] as const).filter((k) => effective(v, k) !== effective(reference, k));
    assert.equal(differences.length, name === "reference" ? 0 : 1, name);
  }
});

test("the regression fails at the first failed case", async () => {
  suite.locations.regression = join(temporary, "regression.json");
  writeFileSync(suite.locations.regression, JSON.stringify({ cases: ["pineapple-price", "thanks"] }), "utf8");
  const answers: Record<string, string> = { "pineapple-price": "The pineapple juice costs 1,000 FCFA.", thanks: "Thank you, have a good evening!" };
  Object.assign(evaluate.dependencies, {
    makeClient: () => new FakeClient(),
    loadKnowledge: () => [],
    run: async (_client: unknown, v: harness.Variant, cases: EvaluationCase[]) => [
      cases.map((c) => makeTrial(v.name, c.id, 1, { category: c.category[0]!, text: answers[c.id]!, claude_text: answers[c.id]! })), false,
    ],
  });
  const args = { variant: "reference", maxBudget: 0.3, parallel: 1 };
  assert.equal(await evaluate.cmdRegression(args), 0);
  answers["pineapple-price"] = "I don't know.";
  assert.equal(await evaluate.cmdRegression(args), 1);
});

test("only the cases passed at every trial enter the regression", () => {
  suite.locations.regression = join(temporary, "regression.json");
  const series = join(temporary, "series");
  const stable = [fact(), makeTrial("v", "pineapple-price", 2, { category: "information", text: "1,000 FCFA", claude_text: "1,000 FCFA" })];
  const unstable = [fact("thanks", "Thank you!"), makeTrial("v", "thanks", 2, { category: "other" })];
  suite.writeSeries(series, [...stable, ...unstable]);
  evaluate.cmdGraduate({ series });
  assert.deepEqual(JSON.parse(readFileSync(suite.locations.regression, "utf8")).cases, ["pineapple-price"]);
});

test("the shipped version is the Comptoir on Haiku", () => {
  // The decision of chapter 17, in the configuration; chapter 12 keeps its Comptoir on Sonnet 5.5.
  assert.equal(config.COMPTOIR_MODEL, "claude-haiku-5-5");
  const shipped = new RoutedComptoir(new FakeClient(), new Shop(), new Budget(), "c1", loadKnowledge().slice(0, 3));
  assert.equal(shipped.comptoir.request("Hello").model, "claude-haiku-5-5");
  assert.equal(suite.versions(suite.VARIANTS.shipped!).comptoir_model, "claude-haiku-5-5");
  assert.equal(suite.versions(suite.VARIANTS.reference!).comptoir_model, "claude-sonnet-5-5");
  assert.ok(readFileSync(join(ROOT, "ch12", "routed_comptoir.ts"), "utf8").includes("comptoirModel: config.MODEL"));
});

test("a series is written as in Python: “0.0”, not “0”", () => {
  const series = join(temporary, "series");
  suite.writeSeries(series, [fact()]);
  const line = readFileSync(join(series, "trials.jsonl"), "utf8");
  assert.ok(line.includes('"cost_dollars": 0.0, "latency_s": 0.0, "error": null}'), line);
  assert.deepEqual(suite.readSeries(series), [fact()]);
});

// --- The same results as the Python version ----------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
const withoutPython = { skip: PYTHON_VENV ? false : "Python environment missing" };
const python = (script: string, input: unknown = null): unknown =>
  JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script], {
      cwd: PYTHON, input: JSON.stringify(input), encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    }),
  );

const BOOK_SERIES = join(PYTHON, "ch17", "results", "series");
const series = existsSync(BOOK_SERIES) ? readdirSync(BOOK_SERIES).sort() : [];
const judgmentFiles = (s: string): [string, string, string][] =>
  readdirSync(join(BOOK_SERIES, s))
    .filter((f) => f.startsWith("judgments-") && f.endsWith(".jsonl"))
    .sort()
    .map((f) => {
      const name = f.slice("judgments-".length, -".jsonl".length);
      return [f, name.slice(0, name.lastIndexOf("-")), name.slice(name.lastIndexOf("-") + 1)];
    });

test("the same generator as random.Random, and the same mean as statistics.mean", withoutPython, () => {
  const ts: Record<string, unknown> = {};
  for (const seed of [0, 17, 1717]) {
    const r = new PythonRandom(seed);
    const list = Array.from({ length: 40 }, (_, i) => `c${i}`);
    const codes = Array.from({ length: 500 }, () => r.randrange(10_000));
    const draws = [r.sample(list, 15), r.sample(Array.from({ length: 300 }, (_, i) => i), 30)];
    const shuffled = [...list];
    r.shuffle(shuffled);
    ts[seed] = { codes, draws, shuffled, choices: Array.from({ length: 30 }, () => r.choice(list)) };
  }
  const g = new PythonRandom(3);
  const values = Array.from({ length: 200 }, (_, n) => Array.from({ length: 1 + (n % 37) }, () => g.randrange(1_000_000) / 1e8));
  const py = python(`
import json, random, statistics, sys
values = json.load(sys.stdin)
output = {}
for seed in (0, 17, 1717):
    r = random.Random(seed)
    lst = [f"c{i}" for i in range(40)]
    codes = [r.randrange(10_000) for _ in range(500)]
    draws = [r.sample(lst, 15), r.sample(list(range(300)), 30)]
    shuffled = list(lst)
    r.shuffle(shuffled)
    output[str(seed)] = {"codes": codes, "draws": draws, "shuffled": shuffled, "choices": [r.choice(lst) for _ in range(30)]}
print(json.dumps({"random": output, "means": [statistics.mean(v) for v in values]}))`, values) as { random: unknown; means: number[] };
  assert.deepEqual(ts, py.random);
  assert.deepEqual(values.map(mean), py.means);
});

test("the same summaries as the Python version, on the book's measured series", { skip: PYTHON_VENV && series.length ? false : "series or Python environment missing" }, () => {
  // The grading by code and the summary, on all the real answers of the chapter (and of chapters 18 and 19):
  // the translation of the patterns and of the calculations is checked on more than a thousand answers.
  const ts: Record<string, Record<string, unknown>> = {};
  for (const s of series) {
    const folder = join(BOOK_SERIES, s);
    const trials = suite.readSeries(folder);
    const r: Record<string, unknown> = { without: suite.summarize(trials, ALL), rates: suite.ratePerCase(trials, ALL) };
    r.shown = suite.show(r.without as suite.Summary);
    r.failures = trials.map((t) => grade(CASES[t.case]!, t));
    for (const [file, model, rubric] of judgmentFiles(s)) {
      const judgments = suite.readJudgments(folder, model, rubric);
      const summary = suite.summarize(trials, ALL, judgments);
      Object.assign(r, { [file]: summary, [`${file}/shown`]: suite.show(summary), [`${file}/rates`]: suite.ratePerCase(trials, ALL, judgments) });
    }
    ts[s] = r;
  }
  const py = python(`
import json, sys
from dataclasses import asdict
from pathlib import Path
from ch17 import suite
from ch17.code_grading import grade
root = Path("ch17/results/series")
cases = suite.load_cases()
by_id = {c["id"]: c for c in cases}
output = {}
for d in sorted(root.iterdir()):
    trials = suite.read_series(d)
    without = suite.summarize(trials, cases)
    r = {"without": without, "rates": suite.rate_per_case(trials, cases), "shown": suite.show(without),
         "failures": [[asdict(f) for f in grade(by_id[t.case], t)] for t in trials]}
    for f in sorted(d.glob("judgments-*.jsonl")):
        model, rubric = f.stem[len("judgments-"):].rsplit("-", 1)
        j = suite.read_judgments(d, model, rubric)
        summary = suite.summarize(trials, cases, j)
        r[f.name], r[f.name + "/shown"], r[f.name + "/rates"] = summary, suite.show(summary), suite.rate_per_case(trials, cases, j)
    output[d.name] = r
print(json.dumps(output, ensure_ascii=False))`) as Record<string, Record<string, unknown>>;
  for (const s of series) {
    for (const key of Object.keys(py[s]!)) assert.deepEqual(ts[s]![key], py[s]![key], `${s}: ${key}`);
    assert.deepEqual(Object.keys(ts[s]!).sort(), Object.keys(py[s]!).sort());
  }
});

test("the same sample as the Python version, and the same calibration", { skip: PYTHON_VENV && series.length ? false : "series or Python environment missing" }, () => {
  const stored = JSON.parse(readFileSync(join(PYTHON, "ch17", "results", "sample.json"), "utf8")) as sample.Sample;
  const grades = JSON.parse(readFileSync(join(PYTHON, "ch17", "results", "human_grades.json"), "utf8")) as Record<string, Record<string, string>>;
  const human = Object.fromEntries(Object.entries(grades).map(([t, g]) => [t, Object.fromEntries(Object.entries(g).filter(([c]) => (judge.CRITERIA as readonly string[]).includes(c)))]));
  const ts: Record<string, unknown> = {};
  for (const s of series.filter((x) => x.endsWith("-improvement"))) {
    const folder = join(BOOK_SERIES, s);
    const r: Record<string, unknown> = { draw: sample.draw(suite.readSeries(folder), ALL, 30) };
    for (const [file, model, rubric] of judgmentFiles(s)) {
      const judgeVerdicts = Object.fromEntries(Object.entries(suite.readJudgments(folder, model, rubric)).filter(([, j]) => Object.keys(j.verdicts ?? {}).length).map(([t, j]) => [t, j.verdicts]));
      r[file] = {
        agreements: calibration.compare(human, judgeVerdicts).map((a) => ({ criterion: a.criterion, n: a.n, agreements: a.agreements, kappa: a.kappa, false_yes: a.false_yes, false_no: a.false_no, others: a.others })),
        overall: calibration.overallAgreement(human, judgeVerdicts),
        shown: calibration.show(calibration.compare(human, judgeVerdicts)),
      };
    }
    ts[s] = r;
  }
  const py = python(`
import json, sys
from dataclasses import asdict
from pathlib import Path
from ch17 import calibration, sample, suite
from ch17.judge import CRITERIA
root = Path("ch17/results/series")
cases = suite.load_cases()
grades = json.loads(Path("ch17/results/human_grades.json").read_text(encoding="utf-8"))
human = {t: {c: v for c, v in g.items() if c in CRITERIA} for t, g in grades.items()}
output = {}
for d in sorted(root.iterdir()):
    if not d.name.endswith("-improvement"):
        continue
    r = {"draw": sample.draw(suite.read_series(d), cases, 30)}
    for f in sorted(d.glob("judgments-*.jsonl")):
        model, rubric = f.stem[len("judgments-"):].rsplit("-", 1)
        judge = {t: j["verdicts"] for t, j in suite.read_judgments(d, model, rubric).items() if j.get("verdicts")}
        results = calibration.compare(human, judge)
        r[f.name] = {"agreements": [asdict(a) for a in results], "overall": list(calibration.overall_agreement(human, judge)),
                     "shown": calibration.show(results)}
    output[d.name] = r
print(json.dumps(output, ensure_ascii=False))`) as Record<string, Record<string, unknown>>;
  assert.deepEqual(ts, py);
  // And the selection the author graded, kept in results/sample.json. It was drawn by the French edition,
  // whose case IDs sort in another order: a draw on the English IDs does not give it again (code-book-checks.md).
  // It remains a sample of that series: one trial per case, two halves that do not overlap.
  const trials = new Set(suite.readSeries(join(BOOK_SERIES, stored.series!)).map(identifier));
  assert.ok(stored.trials.length === 30 && stored.trials.every((t) => trials.has(t)));
  assert.equal(new Set(stored.trials.map((t) => t.split("/")[1])).size, 30);
  assert.deepEqual([...stored.halves.calibration, ...stored.halves.control].sort(), [...stored.trials].sort());
  assert.ok(stored.halves.calibration.every((t) => !stored.halves.control.includes(t)));
});

test("the same judge requests as the Python version", { skip: PYTHON_VENV && series.length ? false : "series or Python environment missing" }, () => {
  const s = series.find((x) => x.endsWith("-haiku-improvement"))!;
  // Varied trials: with a summary, with tools, with a pass-on, failed.
  const trials = suite.readSeries(join(BOOK_SERIES, s)).filter((_, i) => i % 7 === 0);
  const ts = trials.map((t) => judge.request(CASES[t.case]!, t, "claude-haiku-5-5"));
  const py = python(`
import json, sys
from pathlib import Path
from ch17 import judge, suite
cases = {c["id"]: c for c in suite.load_cases()}
trials = [t for i, t in enumerate(suite.read_series(Path("ch17/results/series") / sys.stdin.read().strip('"'))) if i % 7 == 0]
print(json.dumps([judge.request(cases[t.case], t, "claude-haiku-5-5") for t in trials], ensure_ascii=False))`, s);
  assert.deepEqual(ts, py);
  assert.ok(ts.length > 15);
});

/** Cases played by the harness with answers written in advance, in both languages. */
const SCENARIOS: Record<string, [string, string][]> = {
  "complete-order": [
    [JSON.stringify({ category: "order", reason: "order" }), "end_turn"],
    ["@tool order_prepare " + JSON.stringify({ lines: [{ product: "Ginger juice", quantity: 2 }, { product: "Bissap syrup", quantity: 1 }], customer_name: "Mariam", neighborhood: "Gbégamey" }), "tool_use"],
    ["Here is your summary: check it, then answer as shown.", "end_turn"],
  ],
  "pineapple-stock": [
    [JSON.stringify({ category: "order", reason: "stock" }), "end_turn"],
    ["@tool stock_check " + JSON.stringify({ products: ["Pineapple juice"] }), "tool_use"],
    ["Yes, we have some.", "end_turn"],
  ],
  lukewarm: [
    [JSON.stringify({ category: "complaint", reason: "lukewarm" }), "end_turn"],
    [JSON.stringify({ problem: "lukewarm", product: "Bissap juice", when: "yesterday", customer_request: null, urgent: false, summary: "Lukewarm juice." }), "end_turn"],
    ["Sorry. Passed on to Awa, reply within 24 hours.", "end_turn"],
    [JSON.stringify({ critique: "nothing", apologizes: true, announces_pass_on_to_awa: true, promises_something: false, gives_medical_advice: false }), "end_turn"],
  ],
  "pineapple-price": [[JSON.stringify({ category: "information", reason: "price" }), "end_turn"], ["1,000 FCFA a bottle.", "end_turn"]],
};

test("the same harness as the Python version: same requests, same codes, same trials", withoutPython, async () => {
  const answer = ([t, stop]: [string, string]): ReceivedMessage => {
    if (!t.startsWith("@tool ")) return text(t, stop as "end_turn");
    const [, name, ...rest] = t.split(" ");
    return message([{ type: "tool_use", id: "t1", name, input: JSON.parse(rest.join(" ")) }], "tool_use");
  };
  const withoutDurations = (t: Trial): unknown => ({
    ...t, latency_s: null, calls: t.calls.map((c) => ({ ...c, duration_s: null })), steps: t.steps.map((s) => ({ ...s, duration_ms: null })),
  });
  const ts: Record<string, unknown> = {};
  for (const [id, answers] of Object.entries(SCENARIOS)) {
    const client = new FakeClient(...answers.map(answer));
    const trial = await runTrial(client, suite.VARIANTS.shipped!, CASES[id]!, 1, loadKnowledge());
    ts[id] = { requests: client.requests, trial: withoutDurations(trial) };
  }
  const py = python(`
import json, os, sys, tempfile
from dataclasses import asdict
from types import SimpleNamespace
from anthropic.types import TextBlock, ToolUseBlock, Usage
from comptoir import config
from comptoir.knowledge import load_knowledge
from ch17 import harness, suite
config.MODEL, config.EFFORT, config.CUSTOMER_DAILY_QUOTA = "claude-sonnet-5-5", None, 1.0
config.LOG = os.path.join(tempfile.mkdtemp(), "calls.jsonl")  # the real log is not touched
class FakeClient:
    def __init__(self, answers):
        self.messages, self.answers, self.requests = self, list(answers), []
    def create(self, **request):
        self.requests.append(json.loads(json.dumps(request, default=lambda b: b.model_dump(mode="json", exclude_none=True))))
        t, stop = self.answers.pop(0)
        if t.startswith("@tool "):
            _, name, rest = t.split(" ", 2)
            block = ToolUseBlock(type="tool_use", id="t1", name=name, input=json.loads(rest))
        else:
            block = TextBlock(type="text", text=t)
        return SimpleNamespace(content=[block], stop_reason=stop, stop_details=None, usage=Usage(input_tokens=800, output_tokens=80), _request_id="req")
    def count_tokens(self, **request):
        return SimpleNamespace(input_tokens=500)
cases = {c["id"]: c for c in suite.load_cases()}
output = {}
for i, answers in json.load(sys.stdin).items():
    client = FakeClient(answers)
    t = asdict(harness.run_trial(client, suite.VARIANTS["shipped"], cases[i], 1, load_knowledge()))
    t["latency_s"] = None
    t["calls"] = [{**c, "duration_s": None} for c in t["calls"]]
    t["steps"] = [{**s, "duration_ms": None} for s in t["steps"]]
    output[i] = {"requests": client.requests, "trial": t}
print(json.dumps(output, ensure_ascii=False))`, SCENARIOS) as Record<string, unknown>;
  // The IDs of the summary and of the request are drawn at random (uuid4), on both sides; the confirmation
  // codes, for their part, come from the same generator with a fixed seed: they must be the same.
  const withoutIds = (x: unknown): unknown =>
    JSON.parse(JSON.stringify(x).replace(/(\\?"summary\\?": \\?")[0-9a-f]{8}(?![0-9a-z])/g, "$1<id>").replace(/D-[0-9a-f]{6}/g, "D-<id>"));
  assert.deepEqual(withoutIds(ts), withoutIds(py));
  assert.match(JSON.stringify(ts), /confirmation code|YES \d{4}/);
});

test("the same cases fingerprint as the Python version, on the three sets", withoutPython, () => {
  // The book's register keeps the fingerprints of the French run (python/ch17/results/README.md): the English
  // cases have their own, which both versions must compute alike, or their series would not compare.
  const regression = (JSON.parse(readFileSync(join(PYTHON, "ch17", "regression.json"), "utf8")) as { cases: string[] }).cases;
  const ts = [suite.loadCases("improvement"), suite.loadCases("verification"), suite.loadCases(null, regression)].map(suite.casesFingerprint);
  const py = python(`
import json, sys
from ch17 import suite
regression = json.load(sys.stdin)
print(json.dumps([suite.cases_fingerprint(c) for c in (suite.load_cases("improvement"), suite.load_cases("verification"), suite.load_cases(ids=regression))]))`, regression);
  assert.deepEqual(ts, py);
});
