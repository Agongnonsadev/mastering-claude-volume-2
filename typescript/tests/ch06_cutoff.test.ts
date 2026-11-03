// What the TypeScript SDK really does when a stream breaks, against a fake local server
// (python/tests/test_ch06_cutoff.py).
//
// No call to the API: the SDK client talks to a small server on 127.0.0.1, which starts a streamed
// answer then cuts it in three ways. Enough to check, with the installed version of the SDK, what
// comptoir/streaming.ts must recognize. The TypeScript SDK does not behave like the Python one: a stream
// closed without message_stop raises an error there, instead of returning a truncated message.

import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { type Socket, createServer } from "node:net";
import { beforeEach, test } from "node:test";
import { Generation, resumable, streamReply } from "../comptoir/streaming.ts";
import { temporaryLog } from "./fake_clients.ts";

type Ending = "cut" | "error" | "clean_close" | "complete";

const START: [string, object][] = [
  ["message_start", { type: "message_start", message: {
    id: "msg_local", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello, " } }],
];
const NORMAL_END: [string, object][] = [
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
  ["message_stop", { type: "message_stop" }],
];
const OVERLOAD: [string, object] = ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }];

/** An SSE event, in a “chunked” HTTP chunk, as the API sends it. */
function chunk(name: string, data: object): Buffer {
  const bytes = Buffer.from(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  return Buffer.concat([Buffer.from(`${bytes.length.toString(16)}\r\n`), bytes, Buffer.from("\r\n")]);
}

/** A server that answers the successive requests according to the given endings, in order. */
async function server(...endings: Ending[]) {
  const s = createServer((socket: Socket) => {
    let received = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      received = Buffer.concat([received, data]);
      const headers = received.indexOf("\r\n\r\n");
      if (headers < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(received.subarray(0, headers).toString())?.[1] ?? 0);
      if (received.length - headers - 4 < length) return;
      received = Buffer.alloc(0);
      const ending = endings.shift() ?? "complete";
      socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nrequest-id: req_local\r\ntransfer-encoding: chunked\r\n\r\n");
      for (const [name, d] of START) socket.write(chunk(name, d));
      if (ending === "error") socket.write(chunk(...OVERLOAD));
      if (ending === "complete") for (const [name, d] of NORMAL_END) socket.write(chunk(name, d));
      if (ending !== "cut") socket.write("0\r\n\r\n"); // normal end of the HTTP body
      // ending === "cut": the connection closes without finishing the body, like a network that gives way
      setTimeout(() => socket.destroy(), 20);
    });
  });
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const { port } = s.address() as { port: number };
  const client = new Anthropic({ apiKey: "fake-local-key", baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 });
  return { client, close: () => new Promise((ok) => s.close(ok)) };
}

async function attempt(ending: Ending): Promise<{ received: string[]; message: Anthropic.Message | null; error: unknown }> {
  const { client, close } = await server(ending);
  const received: string[] = [];
  try {
    const stream = client.messages.stream({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "Hello" }] });
    for await (const e of stream) if (e.type === "content_block_delta" && e.delta.type === "text_delta") received.push(e.delta.text);
    return { received, message: await stream.finalMessage(), error: null };
  } catch (error) {
    return { received, message: null, error };
  } finally {
    await close();
  }
}

beforeEach(() => {
  temporaryLog();
});

test("a cut connection surfaces as an SDK error, not as an API error", async () => {
  const { received, error } = await attempt("cut");
  assert.deepEqual(received, ["Hello, "]); // the beginning did arrive
  assert.ok(error instanceof Anthropic.AnthropicError);
  assert.ok(!(error instanceof Anthropic.APIError)); // no status
  assert.ok(error.cause !== undefined); // the error of Node's fetch, “terminated”
  assert.ok(resumable(error));
});

test("an error mid-stream has no status, but has its type", async () => {
  const { received, error } = await attempt("error");
  assert.deepEqual(received, ["Hello, "]);
  assert.ok(error instanceof Anthropic.APIError);
  assert.equal(error.status, undefined);
  assert.equal(error.type, "overloaded_error");
  assert.ok(resumable(error));
});

test("a stream closed without message_stop raises an error, without a cause", async () => {
  const { received, error } = await attempt("clean_close");
  assert.deepEqual(received, ["Hello, "]);
  // Python returns a truncated message here, without a stop reason; the TypeScript SDK raises an error.
  assert.ok(error instanceof Anthropic.AnthropicError && !(error instanceof Anthropic.APIError));
  assert.equal(error.cause, undefined);
});

test("with the real SDK, a cut or truncated answer is resumed once", async () => {
  for (const ending of ["cut", "clean_close"] as const) {
    const { client, close } = await server(ending, "complete");
    try {
      const generation = new Generation("c1");
      const result = await streamReply(client, { model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "Hello" }] }, generation);
      assert.ok(result.resumed, ending);
      assert.equal(generation.text, "Hello, Hello, ", ending); // the fake server repeats its beginning
      assert.equal(result.message.stop_reason, "end_turn", ending);
    } finally {
      await close();
    }
  }
});
