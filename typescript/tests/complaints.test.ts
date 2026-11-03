// The complaints chain, with fake clients: no paid call (python/tests/test_complaints.py), and the same
// chain as the Python version: same schemas, same requests, same result.
// The tests of the routed Comptoir are in routing.test.ts.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  EVALUATION_SCHEMA,
  EVALUATION_SYSTEM,
  FACTS_SCHEMA,
  FALLBACK,
  type Facts,
  PRODUCTS,
  PROMISES,
  REPLY_PROMPT,
  handle,
  missing,
  normalize,
} from "../comptoir/complaints.ts";
import { PYTHON } from "../comptoir/launch.ts";
import { Shop } from "../comptoir/shop.ts";
import { Trace } from "../comptoir/trace.ts";
import { FakeClient, restoreConfig, setConfig, temporaryLog, textAnswer as text } from "./fake_clients.ts";

beforeEach(() => {
  temporaryLog();
  setConfig({ MODEL: "claude-sonnet-5-5", EFFORT: null, CUSTOMER_DAILY_QUOTA: 1.0 });
});
afterEach(restoreConfig);

const FACTS: Facts = { problem: "lukewarm", product: "bissap", when: "yesterday", customer_request: null, urgent: false, summary: "Three lukewarm bottles." };
const GOOD = { apologizes: true, announces_pass_on_to_awa: true, promises_something: false, gives_medical_advice: false, critique: "nothing" };
const content = (client: FakeClient, i: number): string => String(client.requests[i]!.messages[0]!.content);

test("the gate asks for what is missing", () => {
  assert.deepEqual(missing(FACTS), []);
  assert.deepEqual(missing({ ...FACTS, product: null, when: null }), ["the product concerned", "the day of the delivery"]);
  assert.deepEqual(missing({ ...FACTS, problem: "late", product: null }), []); // a delay has no product
});

test("the product comes from the catalog", () => {
  const choices = FACTS_SCHEMA.properties.product.anyOf;
  assert.deepEqual(choices[0], { type: "string", enum: PRODUCTS });
  assert.ok(PRODUCTS.includes("Bissap juice"));
  assert.deepEqual(choices[1], { type: "null" }); // “bottles” is not a product: null, and the code asks for it
});

test("the evaluator writes its critique before ticking", () => {
  assert.equal(Object.keys(EVALUATION_SCHEMA.properties)[0], "critique");
  assert.equal(EVALUATION_SCHEMA.required[0], "critique");
});

test("the case of an enum is corrected", () => {
  const facts = normalize({ ...FACTS, problem: "Health", product: "Ginger Juice" });
  assert.ok(facts.problem === "health" && facts.product === "Ginger juice");
});

test("a cut-off draft is rewritten without paying the evaluator", async () => {
  const client = new FakeClient(
    text(JSON.stringify(FACTS)),
    text("Sorry. Your complaint has been passed on to A", "max_tokens"),
    text("Sorry. Passed on to Awa, reply within 24 hours."),
    text(JSON.stringify(GOOD)),
  );
  const result = await handle(client, "The bottles were lukewarm.", new Shop(), "c1");
  assert.ok(result.attempts === 2 && !result.fallback && client.requests.length === 4);
  assert.deepEqual(result.critiques, ["answer stopped by max_tokens"]);
  assert.ok(!content(client, 2).includes("<critique>")); // incomplete, not at fault
  assert.equal(result.reply, "Sorry. Passed on to Awa, reply within 24 hours.");
});

test("an unreadable extraction does not stop the chain", async () => {
  const client = new FakeClient(text('{"problem": "luk', "max_tokens"), text("Sorry. Passed on to Awa, within 24 hours."), text(JSON.stringify(GOOD)));
  const shop = new Shop();
  const result = await handle(client, "The bottles were lukewarm.", shop, "c1");
  assert.deepEqual(result.missing, ["the product concerned", "the day of the delivery"]);
  assert.ok(shop.requests()[0]!.summary.startsWith("Extraction impossible")); // Awa receives the complaint anyway
});

test("the promise pattern", () => {
  assert.ok(PROMISES.test("We will refund you") && PROMISES.test("a store credit of 1,000 FCFA"));
  assert.ok(!PROMISES.test("we do not accept credit cards")); // the card, not the store credit: no promise
  assert.ok(!PROMISES.test("an irreplaceable taste") && PROMISES.test("We will COMPENSATE you")); // word boundaries and case, as in Python
});

test("a complaint compliant at the first attempt", async () => {
  const client = new FakeClient(text(JSON.stringify(FACTS)), text("Sorry. Passed on to Awa, reply within 24 hours."), text(JSON.stringify(GOOD)));
  const shop = new Shop();
  const trace = new Trace();
  const result = await handle(client, "The bottles were lukewarm.", shop, "c1", { trace });
  assert.ok(result.attempts === 1 && !result.fallback);
  assert.deepEqual(result.versions, [result.reply]);
  assert.deepEqual(trace.steps.map((s) => s.name), ["extraction", "check", "pass_on", "drafting", "evaluation"]);
  assert.equal(shop.requests()[0]!.reason, "complaint"); // always passed on to Awa
});

test("a promise is rejected, then the fallback text", async () => {
  const promise = "Sorry, we will refund you. Passed on to Awa.";
  const client = new FakeClient(
    text(JSON.stringify({ ...FACTS, urgent: true })),
    text(promise),
    text(JSON.stringify(GOOD)),
    text(promise),
    text(JSON.stringify(GOOD)),
  );
  const shop = new Shop();
  const result = await handle(client, "My son was sick.", shop, "c1");
  assert.ok(result.fallback && result.reply.startsWith(FALLBACK) && result.reply.includes("health professional"));
  assert.ok(result.critiques.length === 2 && result.critiques[0]!.includes("refund"));
  assert.ok(content(client, 3).includes("<critique>")); // the 2nd draft receives the critique
  assert.equal(shop.requests()[0]!.reason, "urgent-complaint");
});

test("an outage during drafting does not lose the complaint", async () => {
  const shop = new Shop();
  const outage = (): never => {
    throw new Error("network outage");
  };
  await assert.rejects(handle(new FakeClient(text(JSON.stringify(FACTS)), outage), "The bottles were lukewarm.", shop, "c1"), /network outage/);
  assert.equal(shop.requests().length, 1); // passed on before the drafting
});

// --- The same chain as the Python version --------------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
const withoutPython = { skip: PYTHON_VENV ? false : "Python environment missing" };
const python = (script: string, input: unknown = null): unknown =>
  JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script], {
      cwd: PYTHON,
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    }),
  );

const TEXTS = [
  "We will refund the bottle.", "a store credit of 1,000 FCFA", "we do not accept credit cards", "Your store credit is ready",
  "a credit note", "Delivery is free of charge", "a goodwill gesture", "We will compensate you", "Replacement planned",
  "we will replace it", "A gift awaits you", "compensation", "We will COMPENSATE you", "it's on the house", "for free",
  "Sorry. Passed on to Awa, reply within 24 hours.", "She replaces Awa today", "an irreplaceable taste", "two gifts", "nonrefundable",
];
const FACTS_READ = [
  { problem: "Health", product: "Ginger Juice", when: null, customer_request: null, urgent: true, summary: "x" },
  { problem: "unknown", product: "bottles", when: "yesterday", customer_request: "refund", urgent: false, summary: "y" },
  { problem: "LATE", product: null, when: null, customer_request: null, urgent: false, summary: "z" },
  { problem: null, product: "", when: "", customer_request: null, urgent: false, summary: "" },
];

test("the same schemas, prompts, promises and facts as the Python version", withoutPython, () => {
  const ts = {
    schemas: [FACTS_SCHEMA, EVALUATION_SCHEMA],
    texts: [REPLY_PROMPT, EVALUATION_SYSTEM, FALLBACK],
    promises: TEXTS.map((t) => PROMISES.exec(t)?.[0] ?? null),
    facts: FACTS_READ.map((f) => {
      const n = normalize(f);
      return [n, missing(n)];
    }),
  };
  const expected = python(
    `
import json, sys
from comptoir import complaints as c
d = json.load(sys.stdin)
print(json.dumps({"schemas": [c.FACTS_SCHEMA, c.EVALUATION_SCHEMA], "texts": [c.REPLY_PROMPT, c.EVALUATION_SYSTEM, c.FALLBACK],
                  "promises": [m.group(0) if (m := c.PROMISES.search(t)) else None for t in d["texts"]],
                  "facts": [[n, c.missing(n)] for n in (c.normalize(f) for f in d["facts"])]}))`,
    { texts: TEXTS, facts: FACTS_READ },
  );
  assert.deepEqual(ts, expected);
});

/** The scripted answers of a scenario: text, and its stop reason. */
const SCENARIOS: Record<string, [string, string][]> = {
  "cut off then compliant": [[JSON.stringify(FACTS), "end_turn"], ["Sorry. Passed on to A", "max_tokens"], ["Sorry. Passed on to Awa, reply within 24 hours.", "end_turn"], [JSON.stringify(GOOD), "end_turn"]],
  "promise then fallback": [
    [JSON.stringify({ ...FACTS, product: "Bissap Juice", urgent: true }), "end_turn"],
    ["Sorry, we will refund you. Passed on to Awa.", "end_turn"],
    [JSON.stringify({ ...GOOD, promises_something: true, critique: "It promises a refund." }), "end_turn"],
    ["Sorry. Passed on to Awa, a store credit awaits you.", "end_turn"],
    ['{"critique": "unrea', "max_tokens"],
  ],
  "unreadable extraction": [["not JSON", "end_turn"], ["Sorry. Passed on to Awa.", "end_turn"], [JSON.stringify({ ...GOOD, apologizes: false }), "end_turn"], ["Sorry. Passed on to Awa.", "end_turn"], [JSON.stringify(GOOD), "end_turn"]],
};

test("the same chain as the Python version: requests sent and result, in three scenarios", withoutPython, async () => {
  const ts: Record<string, unknown> = {};
  for (const [name, answers] of Object.entries(SCENARIOS)) {
    const client = new FakeClient(...answers.map(([t, stop]) => text(t, stop as "end_turn")));
    const shop = new Shop();
    const { request, ...result } = await handle(client, "My 3 bottles of bissap were lukewarm, yesterday.", shop, "c1");
    ts[name] = { requests: client.requests, result, request: request === shop.requests()[0]!.id, reason: shop.requests()[0]!.reason };
  }
  const expected = python(
    `
import json, os, sys, tempfile
from dataclasses import asdict
from types import SimpleNamespace
from anthropic.types import Usage
from comptoir import config, complaints
from comptoir.shop import Shop
# A temporary log: the real log of the Python version is not touched.
config.MODEL, config.EFFORT, config.LOG = "claude-sonnet-5-5", None, os.path.join(tempfile.mkdtemp(), "calls.jsonl")
class FakeClient:
    def __init__(self, answers):
        self.messages, self.answers, self.requests = self, list(answers), []
    def create(self, **request):
        self.requests.append(json.loads(json.dumps(request)))
        t, stop = self.answers.pop(0)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=t)], stop_reason=stop,
                               usage=Usage(input_tokens=500, output_tokens=60), _request_id="req")
output = {}
for name, answers in json.load(sys.stdin).items():
    client, shop = FakeClient(answers), Shop()
    r = asdict(complaints.handle(client, "My 3 bottles of bissap were lukewarm, yesterday.", shop, "c1"))
    request = r.pop("request")
    output[name] = {"requests": client.requests, "result": r, "request": request == shop.requests()[0][0], "reason": shop.requests()[0][2]}
print(json.dumps(output))`,
    SCENARIOS,
  );
  assert.deepEqual(ts, expected);
});
