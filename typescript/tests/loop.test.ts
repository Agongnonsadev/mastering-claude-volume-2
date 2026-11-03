// The tool loop and the Comptoir that takes orders, with a fake client: no paid call
// (python/tests/test_loop.py).

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Budget } from "../comptoir/budget.ts";
import type { MessagesClient, ReceivedMessage } from "../comptoir/client.ts";
import { ComptoirError, REFUSAL } from "../comptoir/errors.ts";
import { loadKnowledge } from "../comptoir/knowledge.ts";
import { converse } from "../comptoir/loop.ts";
import { ComptoirOrders, renderSummary } from "../comptoir/orders.ts";
import { Shop } from "../comptoir/shop.ts";
import { TOOLS, Tools } from "../comptoir/tools.ts";
import { fakeMessage, restoreConfig, setConfig, temporaryLog } from "./fake_clients.ts";

beforeEach(() => {
  temporaryLog();
  setConfig({ MODEL: "claude-sonnet-5-5", EFFORT: null, CUSTOMER_DAILY_QUOTA: 1.0 });
});
afterEach(restoreConfig);

const reply = (blocks: object[], stopReason: Anthropic.StopReason = "end_turn") =>
  fakeMessage({ content: blocks, usage: { input_tokens: 1500, output_tokens: 120 }, stopReason });
const text = (t: string) => ({ type: "text", text: t, citations: null });
const tool = (name: string, input: object, id: string) => ({ type: "tool_use", id, name, input, caller: { type: "direct" } });

/** Returns the planned replies, one per call, and keeps each request received (copied, as sent). */
class FakeClient implements MessagesClient {
  readonly requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  private readonly replies: ReceivedMessage[];
  readonly messages: MessagesClient["messages"];
  constructor(...replies: ReceivedMessage[]) {
    this.replies = replies;
    this.messages = {
      countTokens: async () => ({ input_tokens: 1500 }),
      create: async (request) => {
        this.requests.push(JSON.parse(JSON.stringify(request)));
        return this.replies.shift()!;
      },
    };
  }
}

const REQUEST: Anthropic.MessageCreateParamsNonStreaming = {
  model: "claude-sonnet-5-5", max_tokens: 2000, system: "s", tools: TOOLS,
  messages: [{ role: "user", content: "Do you have any pineapple and ginger left?" }],
};

test("two parallel calls return their results in one message", async () => {
  const client = new FakeClient(
    reply([
      { type: "thinking", thinking: "", signature: "sig" },
      tool("stock_check", { products: ["Pineapple juice"] }, "t1"),
      tool("stock_check", { products: ["Ginger juice"] }, "t2"),
    ], "tool_use"),
    reply([text("Yes: 12 pineapples and 25 gingers.")]),
  );
  const turn = await converse(client, REQUEST, new Tools(new Shop(), "c1"), new Budget(), "c1");
  assert.equal(turn.text, "Yes: 12 pineapples and 25 gingers.");
  const second = client.requests[1]!.messages;
  assert.deepEqual((second[1]!.content as object[])[0], { type: "thinking", thinking: "", signature: "sig" }); // intact
  const results = second[2]!.content as Anthropic.ToolResultBlockParam[];
  assert.deepEqual(results.map((r) => r.tool_use_id), ["t1", "t2"]);
  assert.equal(second.length, 3);
  assert.deepEqual(turn.newMessages.map((m) => m.role), ["assistant", "user", "assistant"]);
});

test("a loop going round in circles is stopped", async () => {
  const loop = [0, 1, 2].map((i) => reply([tool("stock_check", { products: ["Pineapple juice"] }, `t${i}`)], "tool_use"));
  await assert.rejects(
    converse(new FakeClient(...loop), REQUEST, new Tools(new Shop(), "c1"), new Budget(), "c1", null, 3),
    (e: unknown) => e instanceof ComptoirError && e.diagnostic.code === "loop_too_long",
  );
});

function comptoir(...replies: ReceivedMessage[]) {
  const shop = new Shop(":memory:", { rng: () => 4821 });
  return { c: new ComptoirOrders(new FakeClient(...replies), shop, new Budget(), "c1"), shop };
}

const PREPARE = { lines: [{ product: "Bissap juice", quantity: 6 }], customer_name: "Mrs. Hounkpè", neighborhood: "Akpakpa" };

test("from the order to the confirmation", async () => {
  const { c, shop } = comptoir(
    reply([tool("order_prepare", PREPARE, "t1")], "tool_use"),
    reply([text("Here is your summary; check it before confirming.")]),
  );
  const first = await c.answer("6 bissap to Akpakpa, in the name of Mrs. Hounkpè");
  // The total and the code shown to the customer come from the code, not from Claude.
  const code = shop.summaries("c1")[0]!.code;
  assert.ok(first.text.includes("Total: 6,000 FCFA"));
  assert.ok(first.text.includes(`YES ${code}`));
  assert.deepEqual(shop.orders(), []); // nothing is created before the confirmation

  const confirmation = await c.answer(`yes ${code}`);
  assert.equal(confirmation.turn, null); // the confirmation did not go through Claude
  assert.ok(confirmation.text.includes("C-0001"));
  assert.equal(shop.orders().length, 1);
  // The formatting of the amount must not swallow the sentence's comma (seen in a real measurement).
  assert.ok(confirmation.text.includes("is recorded, for a total of 6,000 FCFA."));
  assert.equal((c.client as FakeClient).requests.length, 2); // no extra call to confirm
  assert.deepEqual(c.history.map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
});

test("a wrong code creates nothing", async () => {
  const { c, shop } = comptoir(reply([tool("order_prepare", PREPARE, "t1")], "tool_use"), reply([text("Check the summary.")]));
  await c.answer("6 bissap");
  const code = shop.summaries("c1")[0]!.code;
  const wrong = code !== "0000" ? "0000" : "1111";
  assert.match((await c.answer(`YES ${wrong}`)).text, /could not confirm/);
  assert.deepEqual(shop.orders(), []);
});

test("a refused answer does not enter the history", async () => {
  const refusal = { ...reply([], "refusal"), stop_details: { type: "refusal", category: "general_harms", explanation: null } } as unknown as ReceivedMessage;
  const { c } = comptoir(refusal);
  assert.equal((await c.answer("A refused request")).text, REFUSAL);
  assert.deepEqual(c.history, []);
});

test("the official summary", () => {
  const summary = new Shop().prepare("c1", [{ product: "Bissap juice", quantity: 2 }], "Mr. Dossou", "Zogbo");
  const t = renderSummary(summary);
  assert.ok(t.includes("2 × Bissap juice: 2,000 FCFA") && t.includes("Delivery (Zogbo") && t.includes(": 500 FCFA"));
  assert.ok(t.endsWith(`YES ${summary.confirmation_code}`));
});

test("Awa's base is sent, but never recorded", async () => {
  // Chapter 11: the v3 Comptoir attaches the base to the first message of each request, with the cache.
  const client = new FakeClient(reply([text("Hello!")]), reply([text("Yes.")]));
  const c = new ComptoirOrders(client, new Shop(), new Budget(), "c1", { promptVersion: "v3", knowledge: loadKnowledge().slice(0, 3), cache: true });
  await c.answer("Hello");
  await c.answer("Do you deliver on Sundays?");
  const [first, second] = client.requests;
  assert.deepEqual((first!.messages[0]!.content as { type: string }[]).slice(0, 3).map((b) => b.type), ["search_result", "search_result", "search_result"]);
  assert.deepEqual(second!.messages[0], first!.messages[0]); // same beginning of request: read from the cache
  assert.deepEqual(first!.cache_control, { type: "ephemeral" });
  assert.deepEqual(first!.tools, TOOLS);
  assert.equal(typeof c.history[0]!.content, "string"); // the history keeps the customer's message alone
});
