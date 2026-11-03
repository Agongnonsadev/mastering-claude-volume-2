// The Comptoir of chapter 5, with a fake client: no paid call (python/tests/test_assistant.py).

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { answer, buildRequest } from "../comptoir/assistant.ts";
import type { MessagesClient } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import { load } from "../comptoir/prompt.ts";
import { fakeMessage, temporaryLog } from "./fake_clients.ts";

const initialEffort = config.EFFORT;
afterEach(() => {
  config.EFFORT = initialEffort;
});

function fakeClient() {
  const client = {
    request: null as Anthropic.MessageCreateParamsNonStreaming | null,
    messages: {
      create: async (request: Anthropic.MessageCreateParamsNonStreaming) => {
        client.request = request;
        return fakeMessage({
          content: [{ type: "text", text: "The syrup costs 2,500 FCFA.", citations: null }],
          usage: { input_tokens: 900, output_tokens: 60 },
        });
      },
      countTokens: async () => ({ input_tokens: 0 }),
    },
  } satisfies MessagesClient & { request: unknown };
  return client;
}

test("the request tags the message and uses prompt v1", () => {
  const request = buildRequest("How much is the syrup?");
  assert.equal(request.system, load("v1").text);
  assert.deepEqual(request.messages, [{ role: "user", content: "<customer_message>\nHow much is the syrup?\n</customer_message>" }]);
  assert.ok(!("temperature" in request));
});

test("Awa's instruction follows the customer's message", () => {
  const request = buildRequest("3 soursops tonight?", { instructions: ["Soursop out of stock."] });
  assert.deepEqual(request.messages.map((m) => m.role), ["user", "system"]);
  assert.equal(request.messages.at(-1)?.content, "Soursop out of stock.");
  // The system prompt, for its part, has not moved: its cache remains valid.
  assert.equal(request.system, buildRequest("something else").system);
});

test("the history is kept as is", () => {
  const history: Anthropic.MessageParam[] = [
    { role: "user", content: "<customer_message>\nHello\n</customer_message>" },
    { role: "assistant", content: "Hello! What can I do for you?" },
  ];
  const request = buildRequest("The bissap?", { history });
  assert.deepEqual(request.messages.slice(0, 2), history);
  assert.equal(request.messages.length, 3);
});

test("the effort comes from the configuration", () => {
  config.EFFORT = "low";
  assert.deepEqual(buildRequest("?").output_config, { effort: "low" });
  config.EFFORT = null;
  assert.ok(!("output_config" in buildRequest("?")));
});

test("another model, being evaluated, does not inherit the Comptoir's effort", () => {
  config.EFFORT = "low";
  const request = buildRequest("?", { model: "claude-haiku-5-5" });
  assert.equal(request.model, "claude-haiku-5-5");
  assert.ok(!("output_config" in request));
  assert.deepEqual(buildRequest("?", { model: "claude-haiku-5-5", effort: "medium" }).output_config, { effort: "medium" });
});

test("automatic caching and Awa's documents at the top of the first message", () => {
  const blocks: Anthropic.SearchResultBlockParam[] = [
    { type: "search_result", source: "faq.md", title: "FAQ", content: [{ type: "text", text: "Delivery in Cotonou." }] },
  ];
  const request = buildRequest("Do you deliver?", { cache: true, knowledge: blocks });
  assert.deepEqual(request.cache_control, { type: "ephemeral" });
  const first = request.messages[0]!;
  assert.ok(Array.isArray(first.content));
  assert.deepEqual(first.content[0], blocks[0]);
  assert.deepEqual(first.content[1], { type: "text", text: "<customer_message>\nDo you deliver?\n</customer_message>" });
});

test("the log records the prompt version", async () => {
  const log = temporaryLog();
  const { text } = await answer(fakeClient(), "How much is the syrup?");
  assert.equal(text, "The syrup costs 2,500 FCFA.");
  const line = JSON.parse(readFileSync(log, "utf8"));
  assert.equal(line.prompt, load("v1").id);
});
