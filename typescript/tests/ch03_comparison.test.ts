// The comparison of models, with a fake client that imitates two models: no paid call
// (python/tests/test_ch03_comparison.py).

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { type Configuration, compare, estimate, loadCases, summarize } from "../ch03/compare_models.ts";
import type { MessagesClient } from "../comptoir/client.ts";
import { makeCase } from "../comptoir/notation.ts";
import { approx, fakeMessage, temporaryLog } from "./fake_clients.ts";

/** The “big” model answers right; the “small” one gets the syrup's price wrong. */
function fakeClient() {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client = {
    requests,
    messages: {
      create: async (request: Anthropic.MessageCreateParamsNonStreaming) => {
        requests.push(request);
        const question = String(request.messages[0]?.content);
        const rightPrice = request.model === "claude-opus-5-5" || !question.includes("syrup");
        return fakeMessage({
          content: [{ type: "text", text: rightPrice ? "The syrup costs 2,500 FCFA." : "The syrup costs 3,000 FCFA.", citations: null }],
          usage: { input_tokens: 500, output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } },
          model: request.model,
        });
      },
      countTokens: async () => ({ input_tokens: 500 }),
    },
  } satisfies MessagesClient & { requests: unknown };
  return client;
}

const CASES = [
  makeCase({ id: "syrup-price", question: "How much is the syrup?", must_contain: ["2,500"] }),
  makeCase({ id: "other", question: "And the juice?", must_contain: ["2,500"] }),
];
const CONFIGS: Configuration[] = [
  ["claude-opus-5-5", "medium"],
  ["claude-haiku-5-5", "low"],
];

beforeEach(() => {
  temporaryLog();
});

test("each case is repeated for each configuration", async () => {
  const client = fakeClient();
  const trials = await compare(client, CASES, CONFIGS, 3, 10);
  assert.equal(trials.length, 2 * 2 * 3);
  assert.deepEqual(new Set(client.requests.map((r) => r.output_config?.effort)), new Set(["medium", "low"]));
  assert.ok(client.requests.every((r) => !("temperature" in r)));
});

test("cost per successful task", async () => {
  const trials = await compare(fakeClient(), CASES, CONFIGS, 2, 10);
  const summary = new Map(summarize(trials).map((l) => [`${l.model} ${l.effort}`, l]));
  const opus = summary.get("claude-opus-5-5 medium")!;
  const haiku = summary.get("claude-haiku-5-5 low")!;
  assert.equal(opus.success, 1.0);
  assert.equal(haiku.success, 0.5);
  const haikuCost = (500 * 0.1 + 100 * 0.5) / 1e6;
  // The small model succeeds only once out of two: its success costs two calls.
  approx(haiku.costPerSuccess!, 2 * haikuCost);
  assert.equal(opus.averageThinking, 40);
});

test("the budget stops the comparison", async () => {
  // An Opus call costs $0.004 here: with a $0.005 budget, it stops after the second.
  const trials = await compare(fakeClient(), CASES, CONFIGS, 3, 0.005);
  assert.equal(trials.length, 2);
});

test("free estimate", async () => {
  const total = await estimate(fakeClient(), CASES, CONFIGS, 1, 100);
  approx(total, (2 * (500 * 4 + 100 * 20)) / 1e6 + (2 * (500 * 0.1 + 100 * 0.5)) / 1e6);
});

test("the book's cases load", () => {
  const cases = loadCases();
  assert.equal(cases.length, 15);
  assert.equal(new Set(cases.map((c) => c.id)).size, 15);
});
