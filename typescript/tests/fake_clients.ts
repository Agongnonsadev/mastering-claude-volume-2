// Fake messages and fake clients for the tests: no paid call.

import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessagesClient, ReceivedMessage } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import type { MessageStream, StreamingClient } from "../comptoir/streaming.ts";

/** A complete message, as the SDK would return it, from its blocks and its usage alone. */
export function fakeMessage({
  content,
  usage = {},
  stopReason = "end_turn",
  model = "claude-sonnet-5-5",
  id = "req_test",
}: {
  content: object[];
  usage?: Partial<Anthropic.Usage>;
  stopReason?: Anthropic.StopReason;
  model?: string;
  id?: string;
}): ReceivedMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens_details: null,
      server_tool_use: null,
      ...usage,
    },
    _request_id: id,
  } as unknown as ReceivedMessage;
}

/** Like pytest.approx: equality to within a millionth, in relative value. */
export function approx(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) <= 1e-6 * Math.max(Math.abs(expected), 1e-12), `${actual} ≠ ${expected}`);
}

/** The call log in a temporary folder, for the time of a test. */
export function temporaryLog(): string {
  const path = join(mkdtempSync(join(tmpdir(), "comptoir-")), "calls.jsonl");
  config.LOG = path;
  return path;
}

const toRestore: (() => void)[] = [];

/**
 * Changes settings for the time of a test, like monkeypatch.setattr: restoreConfig(), called after each
 * test, gives them back their previous value, in reverse order.
 */
export function setConfig(values: Partial<typeof config>): void {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, config[key as keyof typeof config]]));
  Object.assign(config, values);
  toRestore.push(() => Object.assign(config, before));
}

export function restoreConfig(): void {
  while (toRestore.length) toRestore.pop()!();
}

/** The lines of the log, one per call or per event. */
export const logLines = (path: string): Record<string, unknown>[] =>
  readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// --- Streaming (chapter 6) -----------------------------------------------------------------------

/** A final message as the SDK returns it: a thinking block (display omitted) then the text. */
export function finalMessage(text: string, { thinking = true, stopReason = "end_turn" as Anthropic.StopReason | null } = {}): Anthropic.Message {
  const blocks: object[] = thinking ? [{ type: "thinking", thinking: "", signature: "test-signature" }] : [];
  blocks.push({ type: "text", text, citations: null });
  return fakeMessage({ content: blocks, usage: { input_tokens: 1000, output_tokens: 50 }, stopReason: stopReason as Anthropic.StopReason });
}

/** Yields the chunks one by one; raises `error` before the chunk at index `cutAt`. */
export class FakeStream implements MessageStream {
  readonly request_id = "req_test";
  readonly message: Anthropic.Message;
  constructor(
    readonly chunks: string[],
    readonly options: { message?: Anthropic.Message; cutAt?: number; error?: unknown; waitMs?: number } = {},
  ) {
    this.message = options.message ?? finalMessage(chunks.join(""));
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Anthropic.MessageStreamEvent> {
    for (const [index, chunk] of this.chunks.entries()) {
      if (index === this.options.cutAt) throw this.options.error;
      await new Promise((ok) => setTimeout(ok, this.options.waitMs ?? 0));
      yield { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: chunk } } as Anthropic.MessageStreamEvent;
    }
  }

  async finalMessage(): Promise<Anthropic.Message> {
    return this.message;
  }
}

/** Each call to messages.stream() consumes the next stream of the list. */
export class FakeStreamingClient implements StreamingClient {
  readonly requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  counts = 0;
  private readonly streams: FakeStream[];
  readonly messages: StreamingClient["messages"];

  constructor(...streams: FakeStream[]) {
    this.streams = streams;
    this.messages = {
      stream: (request) => {
        this.requests.push(request);
        const next = this.streams.shift();
        if (!next) throw new Error("The fake client has no stream left to return.");
        return next;
      },
      // Chapter 8: the budget counts the input before calling.
      countTokens: async () => {
        this.counts++;
        return { input_tokens: 1000 };
      },
    };
  }
}

/** An API error, as the SDK raises it for this status (the right class: 400, 401, 429…). */
export function apiError(status: number, type = "api_error", message = "", details?: object, headers: Record<string, string> = {}): Error {
  const body = { type: "error", error: { type, message, ...(details ? { details } : {}) } };
  return Anthropic.APIError.generate(status, body, message, new Headers(headers));
}

// --- Answers written in advance (chapter 12) -----------------------------------------------------

/** A text-only message, as the SDK would return it (500 input tokens, 60 output). */
export const textAnswer = (text: string, stopReason: Anthropic.StopReason = "end_turn"): ReceivedMessage =>
  fakeMessage({ content: [{ type: "text", text, citations: null }], usage: { input_tokens: 500, output_tokens: 60 }, stopReason, id: "req" });

/**
 * Returns the planned answers, one per call, and keeps each request received, copied as sent (a history
 * modified afterwards does not change it). countTokens always counts 500 tokens.
 */
export class FakeClient implements MessagesClient {
  readonly requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  readonly answers: (ReceivedMessage | (() => ReceivedMessage))[];
  readonly messages: MessagesClient["messages"];

  constructor(...answers: (ReceivedMessage | (() => ReceivedMessage))[]) {
    this.answers = answers;
    this.messages = {
      countTokens: async () => ({ input_tokens: 500 }),
      create: async (request) => {
        this.requests.push(JSON.parse(JSON.stringify(request)));
        const next = this.answers.shift();
        if (!next) throw new Error("The fake client has no answer left to return.");
        return typeof next === "function" ? next() : next;
      },
    };
  }
}
