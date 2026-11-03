// The robust call of chapter 8, with a fake client: budget, log, diagnoses (python/tests/test_call.py).

import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Budget } from "../comptoir/budget.ts";
import { OverBudget, callClaude } from "../comptoir/call.ts";
import type { MessagesClient } from "../comptoir/client.ts";
import { ComptoirError } from "../comptoir/errors.ts";
import { apiError, approx, fakeMessage, logLines, restoreConfig, setConfig, temporaryLog } from "./fake_clients.ts";

const REQUEST: Anthropic.MessageCreateParamsNonStreaming = {
  model: "claude-sonnet-5-5",
  max_tokens: 2000,
  system: "s",
  messages: [{ role: "user", content: "Hello" }],
};

let log: string;
beforeEach(() => {
  log = temporaryLog();
  setConfig({ CUSTOMER_DAILY_QUOTA: 0.15, DAILY_BUDGET: 1.3, MONTHLY_BUDGET: 26.0 });
});
afterEach(restoreConfig);

function fakeClient(error?: unknown, stopReason: Anthropic.StopReason = "end_turn") {
  const client = {
    calls: 0,
    messages: {
      countTokens: async (request: Anthropic.MessageCountTokensParams) => {
        assert.ok(!("max_tokens" in request)); // the counting tool does not take it
        return { input_tokens: 1000 };
      },
      create: async () => {
        client.calls++;
        if (error) throw error;
        const message = fakeMessage({
          content: [{ type: "text", text: "Hello!", citations: null }],
          usage: { input_tokens: 1000, output_tokens: 100 },
          stopReason,
        });
        return { ...message, stop_details: stopReason === "refusal" ? { type: "refusal", category: "general_harms", explanation: null } : null };
      },
    },
  } satisfies MessagesClient & { calls: number };
  return client;
}

test("a successful call settles the real cost and is logged", async () => {
  const budget = new Budget();
  const reply = await callClaude(fakeClient(), REQUEST, budget, "c1");
  assert.equal(reply.text, "Hello!");
  assert.equal(reply.stop, null);
  approx(budget.forCustomer("c1"), reply.cost.dollars); // not the reserved maximum
  const line = logLines(log)[0]!;
  assert.equal(line.customer, "c1");
  assert.equal(line.stop_reason, "end_turn");
  assert.ok("duration_ms" in line);
});

test("over budget, no call goes out", async () => {
  setConfig({ CUSTOMER_DAILY_QUOTA: 0.0001 });
  const client = fakeClient();
  await assert.rejects(callClaude(client, REQUEST, new Budget(), "c1"), OverBudget);
  assert.equal(client.calls, 0);
  const line = logLines(log)[0]!;
  assert.equal(line.event, "over_budget");
  assert.equal(line.reason, "customer_quota");
});

test("an API error releases the reservation", async () => {
  const budget = new Budget();
  await assert.rejects(callClaude(fakeClient(apiError(401, "authentication_error")), REQUEST, budget, "c1"), (error: unknown) => {
    assert.ok(error instanceof ComptoirError);
    assert.equal(error.diagnostic.code, "invalid_key");
    return true;
  });
  assert.equal(budget.forDay(), 0); // an error returned by the API is not billed
  assert.equal(logLines(log)[0]!.error, "invalid_key");
});

test("a network cut keeps the reservation", async () => {
  const budget = new Budget();
  const cut = new Anthropic.AnthropicError("terminated", { cause: new TypeError("terminated") });
  await assert.rejects(callClaude(fakeClient(cut), REQUEST, budget, "c1"), ComptoirError);
  assert.ok(budget.forDay() > 0); // the request may have gone through without the answer arriving
});

test("a refusal arrives like a normal answer", async () => {
  const reply = await callClaude(fakeClient(undefined, "refusal"), REQUEST, new Budget(), "c1");
  assert.equal(reply.stop?.code, "refusal");
  assert.match(reply.stop!.forYao, /general_harms/);
  assert.equal(logLines(log)[0]!.error, "refusal");
});
