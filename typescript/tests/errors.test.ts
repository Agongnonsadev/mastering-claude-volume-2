// Each error gets the right diagnosis: retry or fix, and where it comes from
// (python/tests/test_errors.py, with the error classes of the TypeScript SDK).

import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { test } from "node:test";
import { IncompleteStream, REFUSAL, TEMPORARY, UNAVAILABLE, diagnose, diagnoseStop } from "../comptoir/errors.ts";
import { apiError } from "./fake_clients.ts";

const CASES: [string, unknown, string, boolean, string][] = [
  ["401", apiError(401, "authentication_error"), "invalid_key", false, "account"],
  ["402", apiError(402, "billing_error"), "billing", false, "account"],
  ["403", apiError(403, "permission_error"), "permission", false, "account"],
  ["404", apiError(404, "not_found_error"), "not_found", false, "integration"],
  ["413", apiError(413, "request_too_large"), "request_too_large", false, "integration"],
  ["400", apiError(400, "invalid_request_error", "messages.0: bad"), "invalid_request", false, "integration"],
  ["529", apiError(529, "overloaded_error"), "overloaded", true, "service"],
  ["500", apiError(500, "api_error"), "internal_error", true, "service"],
  ["504", apiError(504, "timeout_error"), "api_timeout", true, "service"],
  ["timeout", new Anthropic.APIConnectionTimeoutError(), "timeout", true, "network"],
  ["connection", new Anthropic.APIConnectionError({ message: "Connection error." }), "connection", true, "network"],
  ["cut mid-stream", new Anthropic.AnthropicError("terminated", { cause: new TypeError("terminated") }), "connection", true, "network"],
  ["incomplete stream", new IncompleteStream(), "incomplete_stream", true, "network"],
  ["bug", new TypeError("bug"), "unknown", false, "integration"],
];

for (const [name, error, code, retry, origin] of CASES) {
  test(`each error has its diagnosis: ${name}`, () => {
    const d = diagnose(error);
    assert.deepEqual([d.code, d.retry, d.origin], [code, retry, origin]);
    assert.ok([TEMPORARY, UNAVAILABLE].includes(d.forCustomer));
  });
}

test("a rate limit is retried after the requested delay", () => {
  const d = diagnose(apiError(429, "rate_limit_error", "", undefined, { "retry-after": "12" }));
  assert.equal(d.code, "rate_limit");
  assert.ok(d.retry);
  assert.equal(d.waitS, 12);
});

test("the tier's ceiling is not retried", () => {
  // Same status and same type as a rate limit, but a code that changes everything.
  const error = apiError(429, "rate_limit_error", "You have reached your API usage limits: ...", { error_code: "enforced_spend_limit_reached" });
  const d = diagnose(error);
  assert.equal(d.code, "tier_ceiling");
  assert.equal(d.retry, false);
});

test("the spend limit you have set", () => {
  const error = apiError(400, "invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-11-01.");
  assert.equal(diagnose(error).code, "spend_limit");
});

test("an error announced mid-stream, without a status, is read from its type", () => {
  const body = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
  const error = new Anthropic.APIError(undefined, body, JSON.stringify(body), undefined, "overloaded_error");
  assert.equal(diagnose(error).code, "overloaded");
});

test("the stop reasons", () => {
  const d = diagnoseStop({ stop_reason: "refusal", stop_details: { category: "cyber" } });
  assert.equal(d?.code, "refusal");
  assert.match(d!.forYao, /cyber/);
  assert.equal(d!.forCustomer, REFUSAL);
  assert.equal(diagnoseStop({ stop_reason: "max_tokens" })?.code, "cut_off_answer");
  assert.equal(diagnoseStop({ stop_reason: "model_context_window_exceeded" })?.code, "context_full");
  assert.equal(diagnoseStop({ stop_reason: "end_turn" }), null);
});
