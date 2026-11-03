// Tests of the cost calculator, without any call to the API: those of python/tests/test_costs.py, plus web
// search, the maximum cost and the cache duration, which the Python version tests with their chapters.

import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheDuration, cost, maxCost } from "../comptoir/costs.ts";
import { approx } from "./fake_clients.ts";

test("the book's example on Sonnet", () => {
  // Chapter 1: 2,000 input tokens and 300 output tokens on Sonnet 5.5 = $0.007.
  approx(cost("claude-sonnet-5-5", { input_tokens: 2000, output_tokens: 300 }).dollars, 0.007);
});

test("display in dollars", () => {
  const price = cost("claude-sonnet-5-5", { input_tokens: 2000, output_tokens: 300 });
  assert.equal(String(price), "$0.0070");
});

test("accepts a usage read back from a JSON, with null fields", () => {
  approx(cost("claude-sonnet-5-5", { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: null }).dollars, 0.007);
});

const WITH_CACHE = {
  input_tokens: 50,
  output_tokens: 100,
  cache_read_input_tokens: 10_000,
  cache_creation_input_tokens: 3_000,
  cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 1_000 },
};
const PRICE_WITH_CACHE = (50 * 2 + 100 * 10 + 10_000 * 0.1 + 2_000 * 2.5 + 1_000 * 4.0) / 1_000_000;

test("cache: read and writes", () => {
  approx(cost("claude-sonnet-5-5", WITH_CACHE).dollars, PRICE_WITH_CACHE);
});

test("a write without detail is counted as five minutes", () => {
  approx(cost("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }).dollars, 5.0);
});

test("Haiku changes rate beyond 100,000 tokens", () => {
  approx(cost("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 1_000 }).dollars, (100_000 * 0.1 + 1_000 * 0.5) / 1e6);
  approx(cost("claude-haiku-5-5", { input_tokens: 100_001, output_tokens: 1_000 }).dollars, (100_001 * 0.5 + 1_000 * 2.5) / 1e6);
});

test("the cache counts in the length of Haiku's prompt", () => {
  // 1,000 tokens outside the cache + 150,000 read from the cache: the prompt goes beyond 100,000 tokens.
  const usage = { input_tokens: 1_000, output_tokens: 0, cache_read_input_tokens: 150_000 };
  approx(cost("claude-haiku-5-5", usage).dollars, (1_000 * 0.5 + 150_000 * 0.05) / 1e6);
});

test("unknown model", () => {
  assert.throws(() => cost("claude-imaginary-model", { input_tokens: 1, output_tokens: 1 }), /Unknown price/);
});

// Chapter 4: the Batch API discount.

test("a batch halves the book's example", () => {
  approx(cost("claude-sonnet-5-5", { input_tokens: 2000, output_tokens: 300 }, true).dollars, 0.0035);
});

test("the batch discount stacks with the cache", () => {
  approx(cost("claude-sonnet-5-5", WITH_CACHE, true).dollars, PRICE_WITH_CACHE * 0.5);
});

test("batch and Haiku's long prompt: the threshold applies to the raw tokens", () => {
  approx(cost("claude-haiku-5-5", { input_tokens: 100_001, output_tokens: 1_000 }, true).dollars, ((100_001 * 0.5 + 1_000 * 2.5) / 1e6) * 0.5);
});

test("no batch by default, and a batch keeps the token counts", () => {
  const usage = { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 500 };
  assert.deepEqual(cost("claude-sonnet-5-5", usage), cost("claude-sonnet-5-5", usage, false));
  const byBatch = cost("claude-sonnet-5-5", usage, true);
  assert.deepEqual([byBatch.input, byBatch.cacheRead, byBatch.output], [2000, 500, 300]);
});

// Chapter 10: web searches, billed separately, without the batch discount.

test("a web search costs one cent, on top of the tokens", () => {
  const usage = { input_tokens: 2000, output_tokens: 300, server_tool_use: { web_search_requests: 3 } };
  approx(cost("claude-sonnet-5-5", usage).dollars, 0.007 + 0.03);
  approx(cost("claude-sonnet-5-5", usage, true).dollars, 0.0035 + 0.03);
});

// Chapter 8: the worst case, before the call; chapter 11: with a cache breakpoint.

test("maximum cost of a call, with or without writing to the cache", () => {
  approx(maxCost("claude-sonnet-5-5", 2000, 1000), (2000 * 2 + 1000 * 10) / 1e6);
  approx(maxCost("claude-sonnet-5-5", 2000, 1000, "5m"), (2000 * 2.5 + 1000 * 10) / 1e6);
  approx(maxCost("claude-sonnet-5-5", 2000, 1000, "1h"), (2000 * 4 + 1000 * 10) / 1e6);
  approx(maxCost("claude-haiku-5-5", 100_001, 0), (100_001 * 0.5) / 1e6);
});

test("the most expensive cache duration of a request", () => {
  assert.equal(cacheDuration({ messages: [{ role: "user", content: "Hello" }] }), null);
  assert.equal(cacheDuration({ system: [{ type: "text", text: "…", cache_control: { type: "ephemeral" } }] }), "5m");
  assert.equal(
    cacheDuration({
      tools: [{ name: "stock", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "…", cache_control: { type: "ephemeral" } }] }],
    }),
    "1h",
  );
});
