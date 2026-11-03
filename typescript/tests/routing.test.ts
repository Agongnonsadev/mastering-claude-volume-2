// The routed Comptoir, with fake clients: no paid call. The tests of chapter 12
// (python/tests/test_complaints.py), those of the “saying against doing” guard of chapter 18
// (python/tests/test_ch18.py), and the same requests as the Python version.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Budget } from "../comptoir/budget.ts";
import type { ReceivedMessage } from "../comptoir/client.ts";
import { loadKnowledge } from "../comptoir/knowledge.ts";
import { PYTHON } from "../comptoir/launch.ts";
import { RoutedComptoir } from "../comptoir/routing.ts";
import { Shop } from "../comptoir/shop.ts";
import { FakeClient, fakeMessage, restoreConfig, setConfig, temporaryLog, textAnswer as text } from "./fake_clients.ts";

beforeEach(() => {
  temporaryLog();
  setConfig({ MODEL: "claude-sonnet-5-5", EFFORT: null, CUSTOMER_DAILY_QUOTA: 1.0 });
});
afterEach(restoreConfig);

const routing = (category: string): ReceivedMessage => text(JSON.stringify({ category, reason: "test" }));
const base = () => loadKnowledge().slice(0, 3);

// --- Chapter 12 ----------------------------------------------------------------------------------

test("the routed Comptoir sends a question to the documents", async () => {
  const client = new FakeClient(text(JSON.stringify({ category: "information", reason: "zones" })), text("We don't deliver to Godomey."));
  const c = new RoutedComptoir(client, new Shop(), new Budget(), "c1", base());
  const r = await c.answer("Do you deliver to Godomey?");
  assert.ok(r.category === "information" && r.text === "We don't deliver to Godomey.");
  const documents = client.requests[1]!;
  assert.equal(documents.model, "claude-haiku-5-5");
  assert.deepEqual(documents.thinking, { type: "disabled" });
  for (const block of (documents.messages[0]!.content as { citations?: unknown }[]).slice(0, 3)) assert.deepEqual(block.citations, { enabled: false });
  assert.deepEqual(r.trace.steps.map((s) => s.name), ["routing", "documents"]);
  const last = c.comptoir.history.at(-1)!.content as { text: string }[];
  assert.equal(last[0]!.text, "We don't deliver to Godomey."); // the thread is kept
});

test("a cut-off answer goes to the Comptoir", async () => {
  const client = new FakeClient(text(JSON.stringify({ category: "information", reason: "?" })), text("", "max_tokens"), text("The Comptoir answers."));
  const r = await new RoutedComptoir(client, new Shop(), new Budget(), "c1", base()).answer("A question?");
  assert.ok(r.category === "information, fallback" && r.text === "The Comptoir answers.");
  assert.deepEqual(r.trace.steps.map((s) => s.name), ["routing", "documents", "comptoir"]);
  // The routed Comptoir runs on config.COMPTOIR_MODEL, Claude Haiku 5.5, since chapter 17.
  assert.ok(client.requests[2]!.model === "claude-haiku-5-5" && "tools" in client.requests[2]!);
});

test("a complaint goes through the chain, and the thread is kept", async () => {
  const facts = { problem: "lukewarm", product: "Bissap juice", when: "yesterday", customer_request: null, urgent: false, summary: "Lukewarm juice." };
  const good = { critique: "nothing", apologizes: true, announces_pass_on_to_awa: true, promises_something: false, gives_medical_advice: false };
  const client = new FakeClient(routing("complaint"), text(JSON.stringify(facts)), text("Sorry. Passed on to Awa, reply within 24 hours."), text(JSON.stringify(good)));
  const shop = new Shop();
  const c = new RoutedComptoir(client, shop, new Budget(), "c1", base());
  const r = await c.answer("My bissap juice was lukewarm yesterday.");
  assert.ok(r.category === "complaint" && r.text.startsWith("Sorry."));
  assert.deepEqual(r.trace.steps.map((s) => s.name), ["routing", "extraction", "check", "pass_on", "drafting", "evaluation"]);
  assert.equal(shop.requests()[0]!.reason, "complaint");
  assert.equal(c.comptoir.history.length, 2);
});

// --- Chapter 18: the “saying against doing” guard ------------------------------------------------

test("a pass-on announced by the documents goes to the Comptoir", async () => {
  const passOn = { type: "tool_use", id: "t1", name: "pass_to_awa", input: { reason: "other", summary: "Delivery on a Sunday for a wedding?" }, caller: { type: "direct" } };
  const client = new FakeClient(
    routing("information"),
    text("We do not deliver on Sundays. I'm passing your question on to Awa."),
    fakeMessage({ content: [passOn], usage: { input_tokens: 500, output_tokens: 60 }, stopReason: "tool_use", id: "req" }),
    text("Your question has been passed on to Awa, who will answer you directly."),
  );
  const shop = new Shop();
  const r = await new RoutedComptoir(client, shop, new Budget(), "c1", base()).answer("Do you deliver on Sundays for a wedding? Pass it on to Awa.");
  assert.ok(r.category === "information, fallback" && r.text.startsWith("Your question has been passed on"));
  assert.deepEqual(r.trace.steps.map((s) => s.name), ["routing", "documents", "guard", "comptoir"]);
  assert.deepEqual(shop.requests().map((d) => d.reason), ["other"]); // this time, the request exists
  assert.ok("tools" in client.requests[2]!);
});

test("the code keeps a pass-on announced by the Comptoir without the tool", async () => {
  // The answer read in chapter 18 (fake history, trial 2): an announcement, no call to pass_to_awa.
  const read =
    "I can't grant a price of 500 F: only Awa decides on special prices. So I'm passing your request " +
    "for 10 bissap juices for Sèna on to Awa, who will answer you directly.";
  const shop = new Shop();
  const r = await new RoutedComptoir(new FakeClient(routing("order"), text(read)), shop, new Budget(), "c1", base()).answer("10 bissap juices at 500 F");
  assert.equal(r.text, read);
  const requests = shop.requests();
  assert.deepEqual(requests.map((d) => d.reason), ["other"]);
  assert.ok(requests[0]!.summary.includes("10 bissap juices at 500 F"));
});

test("a role description creates no request", async () => {
  const shop = new Shop();
  const client = new FakeClient(routing("other"), text("I am the automated assistant of Délices d'Awa. I forward to Awa everything that needs her decision."));
  await new RoutedComptoir(client, shop, new Budget(), "c1", base()).answer("Are you a robot?");
  assert.deepEqual(shop.requests(), []);
});

test("a documents answer without an announcement stays as is", async () => {
  const client = new FakeClient(routing("information"), text("We do not deliver to Godomey."));
  const r = await new RoutedComptoir(client, new Shop(), new Budget(), "c1", base()).answer("Do you deliver to Godomey?");
  assert.equal(r.category, "information");
  assert.deepEqual(r.trace.steps.map((s) => s.name), ["routing", "documents"]);
});

// --- The same requests as the Python version -----------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

/** Conversations of two messages, and the scripted answers of each call. */
const SCENARIOS: Record<string, { messages: string[]; answers: [string, string][] }> = {
  "information then order": {
    messages: ["Do you deliver to Godomey?", "Then 6 pineapple juices to Akpakpa, in the name of Mrs Hounkpè."],
    answers: [
      [JSON.stringify({ category: "information", reason: "zones" }), "end_turn"],
      ["We do not deliver to Godomey.", "end_turn"],
      [JSON.stringify({ category: "order", reason: "order" }), "end_turn"],
      ["Very well, I'm preparing your summary.", "end_turn"],
    ],
  },
  "documents cut off, then complaint": {
    messages: ["A question?", "My juice was lukewarm!"],
    answers: [
      [JSON.stringify({ category: "Information", reason: "?" }), "end_turn"],
      ["", "max_tokens"],
      ["The Comptoir answers.", "end_turn"],
      [JSON.stringify({ category: "complaint", reason: "lukewarm" }), "end_turn"],
      [JSON.stringify({ problem: "lukewarm", product: null, when: null, customer_request: null, urgent: false, summary: "Lukewarm juice." }), "end_turn"],
      ["Sorry. Passed on to Awa, reply within 24 hours. Which product is it?", "end_turn"],
      [JSON.stringify({ critique: "nothing", apologizes: true, announces_pass_on_to_awa: true, promises_something: false, gives_medical_advice: false }), "end_turn"],
    ],
  },
  "unreadable routing": {
    messages: ["Hello", "YES 1234"],
    answers: [['{"categ', "max_tokens"], ["Hello! What can I do for you?", "end_turn"]],
  },
};

test("the same requests and the same answers as the Python version, on three conversations", { skip: PYTHON_VENV ? false : "Python environment missing" }, async () => {
  const ts: Record<string, unknown> = {};
  for (const [name, { messages, answers }] of Object.entries(SCENARIOS)) {
    const client = new FakeClient(...answers.map(([t, stop]) => text(t, stop as "end_turn")));
    const shop = new Shop();
    const c = new RoutedComptoir(client, shop, new Budget(), "c1", loadKnowledge());
    const outputs: unknown[] = [];
    for (const m of messages) {
      const r = await c.answer(m);
      outputs.push([r.text, r.category, r.trace.steps.map((s) => [s.name, s.model, s.result.startsWith("D-") ? "D-…" : s.result])]);
    }
    ts[name] = { requests: client.requests, outputs, reasons: shop.requests().map((d) => d.reason), history: c.comptoir.history.length };
  }
  const script = `
import json, os, sys, tempfile
from types import SimpleNamespace
from anthropic.types import TextBlock, Usage
from comptoir import config
from comptoir.budget import Budget
from comptoir.knowledge import load_knowledge
from comptoir.routing import RoutedComptoir
from comptoir.shop import Shop
# A temporary log: the real log of the Python version is not touched.
config.MODEL, config.EFFORT, config.CUSTOMER_DAILY_QUOTA = "claude-sonnet-5-5", None, 1.0
config.LOG = os.path.join(tempfile.mkdtemp(), "calls.jsonl")
class FakeClient:
    def __init__(self, answers):
        self.messages, self.answers, self.requests = self, list(answers), []
    def create(self, **request):
        self.requests.append(json.loads(json.dumps(request, default=lambda b: b.model_dump(mode="json", exclude_none=True))))
        t, stop = self.answers.pop(0)
        return SimpleNamespace(content=[TextBlock(type="text", text=t)], stop_reason=stop, stop_details=None,
                               usage=Usage(input_tokens=500, output_tokens=60), _request_id="req")
    def count_tokens(self, **request):
        return SimpleNamespace(input_tokens=500)
output = {}
for name, s in json.load(sys.stdin).items():
    client, shop = FakeClient(s["answers"]), Shop()
    c = RoutedComptoir(client, shop, Budget(), "c1", load_knowledge())
    outputs = []
    for m in s["messages"]:
        r = c.answer(m)
        outputs.append([r.text, r.category, [[s.name, s.model, "D-…" if s.result.startswith("D-") else s.result] for s in r.trace.steps]])
    output[name] = {"requests": client.requests, "outputs": outputs, "reasons": [d[2] for d in shop.requests()],
                    "history": len(c.comptoir.history)}
print(json.dumps(output))`;
  const python = JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script], { cwd: PYTHON, input: JSON.stringify(SCENARIOS), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }),
  );
  assert.deepEqual(ts, python);
});
