// The Comptoir's streaming, with a fake client: resumption after a cut, nothing twice
// (python/tests/test_streaming.py).

import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Generation, IncompleteStream, resumable, resumeRequest, streamReply } from "../comptoir/streaming.ts";
import { FakeStream, FakeStreamingClient, apiError, finalMessage, logLines, temporaryLog } from "./fake_clients.ts";

const REQUEST: Anthropic.MessageCreateParamsNonStreaming = {
  model: "claude-sonnet-5-5",
  max_tokens: 2000,
  system: "prompt",
  messages: [{ role: "user", content: "<customer_message>\nYour juices?\n</customer_message>" }],
};

let log: string;
beforeEach(() => {
  log = temporaryLog();
});

const cut = () => new Anthropic.AnthropicError("terminated", { cause: new TypeError("terminated") });

test("the resumption adds a message without touching the previous ones", () => {
  const rest = resumeRequest(REQUEST, "We have bissap, gin");
  assert.deepEqual(rest.messages.slice(0, 1), REQUEST.messages);
  assert.equal(REQUEST.messages.length, 1); // the original request has not moved
  assert.equal(rest.messages.at(-1)!.role, "user");
  assert.match(String(rest.messages.at(-1)!.content), /We have bissap, gin/);
  assert.equal(rest.system, REQUEST.system);
});

test("the resumption goes before Awa's instructions", () => {
  const withInstruction = { ...REQUEST, messages: [...REQUEST.messages, { role: "system" as const, content: "Soursop out of stock." }] };
  // A system message must stay last or be followed by an answer.
  assert.deepEqual(resumeRequest(withInstruction, "beginning").messages.map((m) => m.role), ["user", "user", "system"]);
});

test("what can be resumed and what cannot", () => {
  const body = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
  assert.ok(resumable(new Anthropic.APIError(undefined, body, "Overloaded", undefined, "overloaded_error"))); // mid-stream
  assert.ok(resumable(cut()));
  assert.ok(resumable(new IncompleteStream()));
  assert.ok(resumable(apiError(500)));
  assert.ok(resumable(new Anthropic.APIConnectionError({ message: "Connection error." })));
  assert.equal(resumable(apiError(400, "invalid_request_error")), false);
  assert.equal(resumable(apiError(401, "authentication_error")), false);
});

test("a connection that comes back resumes at the right chunk", async () => {
  const generation = new Generation("c1");
  for (const chunk of ["Hel", "lo", "!"]) generation.add(chunk);
  generation.finish({ type: "end" });
  const received = [];
  for await (const e of generation.follow(1)) received.push(e);
  assert.deepEqual(received, [["text", 1, "lo"], ["text", 2, "!"], ["end", 3, { type: "end" }]]);
});

test("a sign of life when nothing arrives", async () => {
  const generation = new Generation("c1");
  const reader = generation.follow(0, 0.01);
  const first = (await reader.next()).value;
  generation.add("Yes");
  generation.finish({ type: "end" });
  const rest = [];
  for await (const e of reader) rest.push(e);
  assert.deepEqual([first, ...rest], [["silence", 0, null], ["text", 0, "Yes"], ["end", 1, { type: "end" }]]);
});

test("a stream without incident", async () => {
  const client = new FakeStreamingClient(new FakeStream(["Bissap, ", "ginger."]));
  const generation = new Generation("c1");
  const result = await streamReply(client, REQUEST, generation, "system-v1@test");
  assert.equal(generation.text, "Bissap, ginger.");
  assert.equal(result.resumed, false);
  assert.equal(client.requests.length, 1);
  const line = logLines(log)[0]!;
  assert.equal(line.request, "req_test");
  assert.ok(Number(line.cost_dollars) > 0);
});

test("a cut mid-stream is resumed without duplicates", async () => {
  const cutStream = new FakeStream(["We have ", "bissap", " and"], { cutAt: 2, error: cut() });
  const rest = new FakeStream([" ginger."], { message: finalMessage(" ginger.") });
  const client = new FakeStreamingClient(cutStream, rest);
  const generation = new Generation("c1");
  const result = await streamReply(client, REQUEST, generation);
  assert.ok(result.resumed);
  assert.equal(generation.text, "We have bissap ginger.");
  // The second request contains the partial answer, not the whole first request twice.
  assert.match(String(client.requests[1]!.messages.at(-1)!.content), /We have bissap/);
  assert.deepEqual(logLines(log).map((l) => l.interrupted ?? false), [true, false]);
});

test("a stream closed without message_stop is resumed", async () => {
  const truncated = new FakeStream(["We have "], { message: finalMessage("We have ", { stopReason: null }) });
  const client = new FakeStreamingClient(truncated, new FakeStream(["bissap."]));
  const generation = new Generation("c1");
  assert.ok((await streamReply(client, REQUEST, generation)).resumed);
  assert.equal(generation.text, "We have bissap.");
});

test("an error before the first chunk sends the same request again", async () => {
  const client = new FakeStreamingClient(new FakeStream(["x"], { cutAt: 0, error: apiError(500) }), new FakeStream(["Hello."]));
  const result = await streamReply(client, REQUEST, new Generation("c1"));
  assert.equal(result.resumed, false);
  assert.deepEqual(client.requests[1], REQUEST);
});

test("a refused request is not resumed", async () => {
  const client = new FakeStreamingClient(new FakeStream(["x"], { cutAt: 0, error: apiError(400, "invalid_request_error") }));
  await assert.rejects(streamReply(client, REQUEST, new Generation("c1")), Anthropic.BadRequestError);
  assert.equal(client.requests.length, 1);
});
