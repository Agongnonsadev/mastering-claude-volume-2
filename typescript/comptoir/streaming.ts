// Stream an answer from Claude, keep it for whoever reads it, resume it if the stream breaks (chapter 6).
//
// The generation is decoupled from the browser's connection: Claude writes into a Generation, kept in
// memory; one or more connections read it. If the customer's phone loses the network, the answer goes on
// being written, and the next connection picks up at the chunk where the previous one had stopped.

import Anthropic from "@anthropic-ai/sdk";
import { performance } from "node:perf_hooks";
import { type Cost, cost } from "./costs.ts";
import { IncompleteStream, diagnose, diagnoseStop, isCut } from "./errors.ts";
import { logCall } from "./log.ts";

export { IncompleteStream } from "./errors.ts";

type Request = Anthropic.MessageCreateParamsNonStreaming;

/** What the Comptoir reads from an SDK stream (client.messages.stream): its events, then the final message. */
export interface MessageStream extends AsyncIterable<Anthropic.MessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
  readonly request_id?: string | null;
}

/** The client that streams: the real one (new Anthropic()), or a fake client of the tests. */
export interface StreamingClient {
  messages: {
    stream(request: Request): MessageStream;
    countTokens(request: Anthropic.MessageCountTokensParams): PromiseLike<Anthropic.MessageTokensCount>;
  };
}

// Documented method for the 4.6 and later models: a new user message, which contains the partial answer
// and asks to continue.
export const resumeInstruction = (partial: string): string =>
  "Your previous response was interrupted. It ended like this:\n" +
  `<interrupted_response>\n${partial}\n</interrupted_response>\n` +
  "Continue exactly from where you left off, without repeating what came before.";

// Transient error types that can arrive mid-stream, after the 200 status.
const TRANSIENT_ERRORS = new Set(["overloaded_error", "api_error"]);

/** A cut or an overload can be resumed; a rejected request (400, 401…) cannot. */
export function resumable(error: unknown): boolean {
  if (error instanceof IncompleteStream) return true;
  if (error instanceof Anthropic.APIConnectionError) return true; // before the answer, timeout included
  if (error instanceof Anthropic.APIError) {
    if ((error.status ?? 0) >= 500) return true; // 500 internal error, 529 overloaded
    // An error announced mid-stream has no status in the TypeScript SDK: its type is in the body.
    return error.status === undefined && TRANSIENT_ERRORS.has(error.type ?? "");
  }
  // A connection that gives way mid-stream (checked by tests/ch06_cutoff.test.ts).
  return isCut(error);
}

/**
 * The request that asks Claude to finish a cut answer.
 *
 * A message is added without touching the previous ones: the beginning of the conversation stays
 * identical, its cache and the preserved thinking remain valid. The message goes right after the
 * customer's, before any instructions from Awa, because a mid-conversation system message must stay
 * last or be followed by an answer.
 */
export function resumeRequest(request: Request, partial: string): Request {
  const messages = [...request.messages];
  let position = messages.length;
  while (position && messages[position - 1]!.role === "system") position--;
  messages.splice(position, 0, { role: "user", content: resumeInstruction(partial) });
  return { ...request, messages };
}

export type End = { type: string; [field: string]: unknown };
export type Event = ["text", number, string] | ["end", number, End] | ["silence", number, null];

/**
 * An answer being written. Several connections can follow it; a cut connection picks it up at the index
 * where it was.
 */
export class Generation {
  readonly chunks: string[] = [];
  end: End | null = null;
  finishedAt: number | null = null;
  task: Promise<void> | null = null;
  private signal = Promise.withResolvers<void>();

  constructor(readonly conversation: string) {}

  get text(): string {
    return this.chunks.join("");
  }

  add(chunk: string): void {
    this.chunks.push(chunk);
    this.wake();
  }

  finish(event: End): void {
    this.end = event;
    this.finishedAt = performance.now();
    this.wake();
  }

  private wake(): void {
    const signal = this.signal;
    this.signal = Promise.withResolvers<void>();
    signal.resolve();
  }

  /**
   * Yields ["text", index, chunk] from index `since`, then ["end", index, event].
   *
   * Yields ["silence", index, null] when nothing arrives for maxSilenceS seconds: enough to send a sign
   * of life, so that neither the browser nor a proxy mistakes the connection for dead.
   */
  async *follow(since = 0, maxSilenceS = 15): AsyncGenerator<Event> {
    let index = since;
    while (true) {
      const signal = this.signal.promise; // taken before reading: nothing can slip past us
      while (index < this.chunks.length) {
        yield ["text", index, this.chunks[index]!];
        index++;
      }
      if (this.end !== null) {
        yield ["end", index, this.end];
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      const silence = new Promise<"silence">((ok) => (timer = setTimeout(() => ok("silence"), maxSilenceS * 1000)));
      const what = await Promise.race([signal, silence]);
      clearTimeout(timer);
      if (what === "silence") yield ["silence", index, null];
    }
  }
}

export interface Result {
  message: Anthropic.Message; // the last message received from the API
  cost: Cost; //                 its cost (that of a cut call is not known)
  resumed: boolean; //           true if the answer had to be resumed after a cut
}

const ms = (start: number): number => Math.round(performance.now() - start);

async function oneStream(
  client: StreamingClient,
  request: Request,
  generation: Generation,
  prompt: string | null,
): Promise<{ message: Anthropic.Message; price: Cost }> {
  const start = performance.now();
  let stream: MessageStream | undefined;
  let message: Anthropic.Message;
  try {
    stream = client.messages.stream(request);
    for await (const event of stream) {
      // The text only, never the thinking.
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") generation.add(event.delta.text);
    }
    message = await stream.finalMessage();
    if (message.stop_reason === null) throw new IncompleteStream();
  } catch (raw) {
    // A stream closed before message_stop: the TypeScript SDK raises an AnthropicError without a cause.
    const error =
      raw instanceof Anthropic.AnthropicError && !(raw instanceof Anthropic.APIError) && !isCut(raw)
        ? new IncompleteStream({ cause: raw })
        : raw;
    const d = diagnose(error);
    logCall(stream?.request_id ?? null, request.model, null, {
      prompt, customer: generation.conversation, error: d.code, origin: d.origin, duration_ms: ms(start),
    });
    throw error;
  }
  const price = cost(request.model, message.usage);
  const stop = diagnoseStop(message);
  logCall(stream.request_id ?? null, request.model, price, {
    prompt, customer: generation.conversation, stop_reason: message.stop_reason, duration_ms: ms(start),
    error: stop?.code, origin: stop?.origin,
  });
  return { message, price };
}

/**
 * Streams the answer into `generation`, with at most one resumption if the stream breaks.
 *
 * Only one: if the resumption breaks in turn, the error surfaces, and it is up to the interface to tell
 * the customer rather than insisting.
 */
export async function streamReply(client: StreamingClient, request: Request, generation: Generation, prompt: string | null = null): Promise<Result> {
  try {
    const { message, price } = await oneStream(client, request, generation, prompt);
    return { message, cost: price, resumed: false };
  } catch (error) {
    if (!resumable(error)) throw error;
    const name = error instanceof Error ? error.constructor.name : typeof error;
    console.warn(`Stream interrupted (${name}), resuming after ${generation.chunks.length} chunks`);
  }
  const partial = generation.text;
  // Nothing received: the request is simply sent again. Otherwise, the rest is asked for.
  const rest = partial ? resumeRequest(request, partial) : request;
  const { message, price } = await oneStream(client, rest, generation, prompt);
  return { message, cost: price, resumed: Boolean(partial) };
}
