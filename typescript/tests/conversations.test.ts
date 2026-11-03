// The history of the conversations: append-only, blocks kept as they are, closing and purge
// (python/tests/test_conversations.py).

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Conversations } from "../comptoir/conversations.ts";
import { restoreConfig, setConfig } from "./fake_clients.ts";

const QUESTION = { role: "user", content: "<customer_message>\nHello\n</customer_message>" };
// The blocks as the SDK returns them: citations: null included.
const ANSWER = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "", signature: "sig-1" },
    { type: "text", text: "Hello! What can I do for you?", citations: null },
  ],
};
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

afterEach(restoreConfig);

test("Claude's blocks are kept as they are", () => {
  const conversations = new Conversations();
  const c = conversations.create();
  conversations.addTurn(c, [QUESTION, ANSWER], 1200);
  const history = conversations.history(c);
  assert.deepEqual(history[0], QUESTION);
  // The thinking and its signature are there, and no empty field (citations: null) is left.
  assert.deepEqual(history[1]!.content, [
    { type: "thinking", thinking: "", signature: "sig-1" },
    { type: "text", text: "Hello! What can I do for you?" },
  ]);
});

test("a tool's arguments stay as they are, even null ones", () => {
  const conversations = new Conversations();
  const c = conversations.create();
  const call = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "stock", input: { product: "bissap", size: null } }] };
  conversations.addTurn(c, [QUESTION, call], 100);
  assert.deepEqual(conversations.history(c)[1], call);
});

test("the history only grows longer", () => {
  const conversations = new Conversations();
  const c = conversations.create();
  conversations.addTurn(c, [QUESTION, ANSWER], 1200);
  const before = conversations.history(c);
  conversations.addTurn(c, [QUESTION, { role: "assistant", content: "With pleasure." }], 1500);
  const after = conversations.history(c);
  // The beginning is identical, to the character: the cache and the preserved thinking remain valid.
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(after.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
});

test("a conversation closes after 24 hours, or when it is too long", () => {
  setConfig({ EXPIRY_H: 24, MAX_CONTEXT: 40_000 });
  const conversations = new Conversations();
  const c = conversations.create();
  conversations.addTurn(c, [QUESTION, ANSWER], 1200);
  const now = new Date();
  assert.equal(conversations.closingReason(c, null, now), null);
  assert.equal(conversations.closingReason(c, null, new Date(now.getTime() + 25 * HOUR)), "expired");
  conversations.addTurn(c, [QUESTION, ANSWER], 41_000);
  assert.equal(conversations.closingReason(c, null, now), "too_long");
});

test("a new prompt closes the conversation", () => {
  const conversations = new Conversations();
  const c = conversations.create("system-v1@aaaa1111");
  assert.equal(conversations.closingReason(c, "system-v1@aaaa1111"), null);
  // Awa changed a price: the rendered prompt changes fingerprint, the conversation is closed.
  assert.equal(conversations.closingReason(c, "system-v1@bbbb2222"), "new_prompt");
});

test("the purge deletes old conversations and their messages", () => {
  setConfig({ RETENTION_DAYS: 30 });
  const conversations = new Conversations();
  const c = conversations.create();
  conversations.addTurn(c, [QUESTION, ANSWER], 1200);
  assert.equal(conversations.purge(new Date(Date.now() + 29 * DAY)), 0);
  assert.equal(conversations.purge(new Date(Date.now() + 31 * DAY)), 1);
  assert.equal(conversations.exists(c), false);
  assert.deepEqual(conversations.history(c), []);
});

test("erase at the customer's request", () => {
  const conversations = new Conversations();
  const c = conversations.create();
  conversations.addTurn(c, [QUESTION, ANSWER], 1200);
  assert.ok(conversations.erase(c));
  assert.deepEqual(conversations.history(c), []);
  assert.equal(conversations.erase(c), false);
});
