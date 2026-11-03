// The server tools: definitions, resumption after a pause, sources, errors, files, cost
// (python/tests/test_server_tools.py).

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ReceivedMessage } from "../comptoir/client.ts";
import { cost } from "../comptoir/costs.ts";
import { call, producedFiles, sources, text, toolErrors, webFetch, webSearch } from "../comptoir/server_tools.ts";
import { approx, fakeMessage, logLines, temporaryLog } from "./fake_clients.ts";

let log: string;
beforeEach(() => {
  log = temporaryLog();
});

test("the definitions", () => {
  assert.equal(webSearch().type, "web_search_20250305");
  assert.equal(webSearch(3, null, true).type, "web_search_20260209");
  assert.deepEqual((webSearch(3, ["gouv.bj"]) as Anthropic.WebSearchTool20250305).allowed_domains, ["gouv.bj"]);
  const location = (webSearch() as Anthropic.WebSearchTool20250305).user_location!;
  assert.equal(location.city, "Cotonou");
  assert.ok(!("country" in location)); // “BJ” rejected by the API (400)
  assert.ok(!("allowed_domains" in webSearch()));
  const fetch = webFetch(2, 2000);
  assert.ok(fetch.type === "web_fetch_20250910" && fetch.max_content_tokens === 2000);
});

test("a search costs one cent on top of the tokens", () => {
  const price = cost("claude-sonnet-5-5", {
    input_tokens: 10_000,
    output_tokens: 500,
    server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
  } as Anthropic.Usage);
  assert.equal(price.searches, 2);
  approx(price.dollars, (10_000 * 2) / 1e6 + (500 * 10) / 1e6 + 2 * 0.01);
});

const message = (stopReason: Anthropic.StopReason, blocks: object[], searches = 0): ReceivedMessage =>
  fakeMessage({
    content: blocks,
    stopReason,
    id: "req",
    usage: { input_tokens: 1000, output_tokens: 100, server_tool_use: { web_search_requests: searches, web_fetch_requests: 0 } as Anthropic.ServerToolUsage },
  });

class FakeClient {
  readonly requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  readonly messages = this;
  constructor(private readonly replies: ReceivedMessage[]) {}
  async create(request: Anthropic.MessageCreateParamsNonStreaming): Promise<ReceivedMessage> {
    this.requests.push(request);
    return this.replies.shift()!;
  }
  async countTokens(): Promise<Anthropic.MessageTokensCount> {
    throw new Error("not used");
  }
}

const request = (): Anthropic.MessageCreateParamsNonStreaming => ({
  model: "claude-sonnet-5-5",
  max_tokens: 100,
  tools: [webSearch()],
  messages: [{ role: "user", content: "?" }],
});

test("a pause is resumed by sending the response back as is", async () => {
  const pause = message("pause_turn", [{ type: "server_tool_use", id: "srv1" }], 1);
  const end = message("end_turn", [{ type: "text", text: "Here it is.", citations: null }], 1);
  const client = new FakeClient([pause, end]);
  const first = request();
  const result = await call(client, first);
  assert.ok(result.text === "Here it is." && result.resumptions === 1 && result.searches === 2);
  const second = client.requests[1]!;
  assert.deepEqual(second.messages.at(-1), { role: "assistant", content: pause.content });
  assert.deepEqual(second.tools, first.tools); // the same tools, otherwise the API rejects the resumption
  assert.equal(first.messages.length, 1); // the starting request is not modified
  assert.deepEqual(logLines(log).map((l) => l.stop_reason), ["pause_turn", "end_turn"]);
});

test("an endless pause stops after the number of resumptions allowed", async () => {
  const pauses = Array.from({ length: 3 }, () => message("pause_turn", [{ type: "server_tool_use", id: "srv1" }]));
  await assert.rejects(call(new FakeClient(pauses), request(), 2), /Still paused after 2 resumptions/);
});

test("the sources, the text and the errors", () => {
  const citation = { type: "web_search_result_location", url: "https://example.bj/holidays", title: "Public holidays" };
  const response = message("end_turn", [
    { type: "text", text: "November 1 ", citations: null },
    { type: "text", text: "is a public holiday.", citations: [citation, citation] },
    { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
  ]);
  assert.equal(text(response), "November 1 is a public holiday.");
  assert.deepEqual(sources(response), [{ source: "https://example.bj/holidays", title: "Public holidays" }]);
  assert.deepEqual(toolErrors(response), ["web_search_tool_result: max_uses_exceeded"]);
});

test("a document citation is recognized by its title", () => {
  const citation = { type: "char_location", document_title: "Terms of sale", cited_text: "…" };
  const response = message("end_turn", [{ type: "text", text: "Yes.", citations: [citation] }]);
  assert.deepEqual(sources(response), [{ source: "Terms of sale", title: "Terms of sale" }]);
});

test("the files produced by the code", () => {
  const output = { type: "bash_code_execution_output", file_id: "file_123" };
  const block = { type: "bash_code_execution_tool_result", content: { type: "bash_code_execution_result", content: [output] } };
  assert.deepEqual(producedFiles(message("end_turn", [block])), ["file_123"]);
  const failure = { type: "bash_code_execution_tool_result", content: { type: "bash_code_execution_tool_result_error", error_code: "unavailable" } };
  assert.deepEqual(producedFiles(message("end_turn", [failure])), []);
  assert.deepEqual(toolErrors(message("end_turn", [failure])), ["bash_code_execution_tool_result: unavailable"]);
});
