// The Comptoir on the web (chapters 6 and 8): a page, a stream, kept conversations, and a budget checked
// before each answer. The same page and the same API as the Python version (python/comptoir/web.py),
// with Hono instead of FastAPI.
//
// Chapter 18: limits per network address (comptoir/limits.ts), a maximum request size, a daily quota per
// address, and the deletion of old conversations once a day.
//
// Run locally, from the typescript/ folder:
//     npm run web
// then open http://127.0.0.1:8000

import Anthropic from "@anthropic-ai/sdk";
import { type HttpBindings, serve, upgradeWebSocket } from "@hono/node-server";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { debuglog } from "node:util";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { buildRequest } from "./assistant.ts";
import { Budget } from "./budget.ts";
import { countingRequest } from "./call.ts";
import { config } from "./config.ts";
import { Conversations } from "./conversations.ts";
import { cacheDuration, maxCost } from "./costs.ts";
import { REFUSAL, UNAVAILABLE, diagnose } from "./errors.ts";
import { PYTHON, isMain } from "./launch.ts";
import { RateLimiter, clientAddress } from "./limits.ts";
import { logEvent } from "./log.ts";
import { type SystemPrompt, load } from "./prompt.ts";
import { type End, Generation, type StreamingClient, streamReply } from "./streaming.ts";

const info = debuglog("comptoir"); // shown with NODE_DEBUG=comptoir, like the INFO level in Python

export const KEEP_S = 600; // a finished answer stays 10 minutes in memory, for a connection that comes back
const PURGE_S = 24 * 3600; // old conversations are deleted once a day (chapter 18)

export const Message = z.object({
  conversation: z.string().nullish(),
  message_id: z.string().min(8).max(64), // created by the browser, one per message
  text: z.string().min(1).max(2000),
  since: z.number().int().min(0).default(0), // number of chunks already received (resumption)
});
export type Message = z.infer<typeof Message>;

/** An answer is already in progress in this conversation. */
export class Busy extends Error {}

/** A limit of the address is reached (chapter 18); `wait`: the seconds before trying again. */
export class TooManyMessages extends Error {
  constructor(
    readonly reason: string,
    readonly wait: number,
  ) {
    super(reason);
  }
}

/** The server's state: the API client, the conversations, the answers in progress. */
export class Comptoir {
  readonly generations = new Map<string, Generation>();
  readonly messagesPerMinute = new RateLimiter(config.MESSAGES_PER_MINUTE_LIMIT, 60);
  readonly conversationsPerHour = new RateLimiter(config.CONVERSATIONS_PER_HOUR_LIMIT, 3600);

  /** loadPrompt: today's prompt, reread at each message (a test can supply another one). */
  constructor(
    private _client?: StreamingClient,
    private _conversations?: Conversations,
    private _budget?: Budget,
    private readonly loadPrompt: () => SystemPrompt = () => load(),
  ) {}

  // Created at first use: importing this module must neither read the key nor open the database.
  get client(): StreamingClient {
    return (this._client ??= new Anthropic({ timeout: config.TIMEOUT_S * 1000, maxRetries: config.RETRIES }));
  }

  get budget(): Budget {
    return (this._budget ??= new Budget(config.BUDGET_DB));
  }

  get conversations(): Conversations {
    return (this._conversations ??= new Conversations(config.CONVERSATIONS));
  }

  private forgetOldOnes(): void {
    const limit = performance.now() - KEEP_S * 1000;
    for (const [key, g] of this.generations) if (g.finishedAt !== null && g.finishedAt < limit) this.generations.delete(key);
  }

  private limit(limiter: RateLimiter, reason: string, address: string): void {
    const wait = limiter.accept(address);
    if (wait !== null) {
      logEvent("limit", { reason, address });
      throw new TooManyMessages(reason, wait);
    }
  }

  /** Returns the answer to follow, and the reason if the conversation had to be renewed. */
  launch(m: Message, address = "unknown"): { generation: Generation; reason: string | null } {
    this.forgetOldOnes();

    // The same message, sent again after a cut: it is attached, Claude is not called again.
    const existing = this.generations.get(m.message_id);
    if (existing) {
      if (m.conversation != null && m.conversation !== existing.conversation) throw new Busy(m.conversation); // an ID already taken elsewhere
      return { generation: existing, reason: null };
    }
    // A resumption does not count; a new message does (chapter 18).
    this.limit(this.messagesPerMinute, "messages_per_minute", address);

    const prompt = this.loadPrompt(); // reread at each message: Awa may have changed her catalog
    let conversation = m.conversation ?? null;
    let reason: string | null = null;
    if (conversation && this.conversations.exists(conversation)) {
      reason = this.conversations.closingReason(conversation, prompt.id);
    } else {
      reason = conversation ? "unknown" : null;
    }
    if (!conversation || reason) {
      this.limit(this.conversationsPerHour, "conversations_per_hour", address);
      conversation = this.conversations.create(prompt.id);
    }

    // One answer at a time per conversation: otherwise two answers written without seeing each other
    // would enter the same history, and Claude would reread a past it never lived.
    for (const g of this.generations.values()) if (g.conversation === conversation && g.end === null) throw new Busy(conversation);

    const generation = new Generation(conversation);
    this.generations.set(m.message_id, generation);
    // An unexpected error must neither stop the server (Node would, for a promise rejected without a
    // handler), nor leave the customer waiting for an end that would never come.
    generation.task = this.produce(generation, m.text, prompt, address).catch((error: unknown) => {
      console.error("Answer impossible:", error);
      if (generation.end === null) generation.finish({ type: "error", message: UNAVAILABLE });
    });
    return { generation, reason };
  }

  /** Counts the input (free) and reserves the maximum cost. Returns [reservation, maximum] or null. */
  private async reserve(
    generation: Generation,
    request: Anthropic.MessageCreateParamsNonStreaming,
    address: string,
  ): Promise<[string, number] | null> {
    let input: number;
    try {
      input = (await this.client.messages.countTokens(countingRequest(request))).input_tokens;
    } catch (error) {
      const d = diagnose(error);
      logEvent("counting_impossible", { customer: generation.conversation, error: d.code, origin: d.origin });
      generation.finish({ type: "error", message: d.forCustomer });
      return null;
    }
    const maximum = maxCost(request.model, input, request.max_tokens, cacheDuration(request));
    const decision = this.budget.reserve(generation.conversation, maximum, `address:${address}`);
    if (!decision.accepted) {
      logEvent("over_budget", { reason: decision.reason, customer: generation.conversation });
      generation.finish({ type: "error", message: UNAVAILABLE });
      return null;
    }
    if (decision.alert) {
      console.warn(`Budget: alert threshold crossed (day $${this.budget.forDay().toFixed(4)}, month $${this.budget.forMonth().toFixed(4)})`);
    }
    return [decision.reservation!, maximum];
  }

  private async produce(generation: Generation, text: string, prompt: SystemPrompt, address: string): Promise<void> {
    const history = this.conversations.history(generation.conversation);
    const request = buildRequest(text, { history, prompt });
    const reserved = await this.reserve(generation, request, address);
    if (reserved === null) return;
    const [reservation, maximum] = reserved;
    let result;
    try {
      result = await streamReply(this.client, request, generation, prompt.id);
    } catch (error) {
      // Nothing is written to the history: the question can be asked again as is.
      const d = diagnose(error);
      console.error(`Answer impossible (${d.code}, origin: ${d.origin}):`, error);
      // Refused by the API before writing anything: nothing is billed.
      if (error instanceof Anthropic.APIError && error.status !== undefined && !generation.chunks.length) {
        this.budget.release(reservation);
      }
      generation.finish({ type: "error", message: d.forCustomer });
      return;
    }

    // After a resumption, the cost of the cut call is not known: the reserved maximum is kept.
    this.budget.settle(reservation, result.resumed ? maximum : result.cost.dollars);
    const { message } = result;
    if (message.stop_reason === "refusal") {
      // The text already displayed is to be thrown away, and the turn does not enter the history.
      generation.finish({ type: "refusal", message: REFUSAL });
      return;
    }
    // Normal case: the answer as is, thinking blocks included. After a resumption, the full text, in a
    // single block: the thinking of a cut stream cannot be stitched back.
    const content = result.resumed ? [{ type: "text", text: generation.text }] : message.content;
    const question = request.messages[history.length]!; // the customer's message, as sent
    const u = message.usage;
    const tokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + u.output_tokens;
    this.conversations.addTurn(generation.conversation, [question, { role: "assistant", content }], tokens);
    info("Answer %s: %s", generation.conversation.slice(0, 8), String(result.cost));
    // The cost stays on the server side (log): Awa's customer does not need to see it.
    generation.finish({ type: "end", truncated: message.stop_reason === "max_tokens" });
  }
}

/**
 * An SSE event. The data is in JSON: a line break in Claude's text therefore cannot break the format,
 * where an empty line separates the events.
 */
export function sseEvent(name: string, data: object, eventId?: number): string {
  const lines = [`event: ${name}`];
  if (eventId !== undefined) lines.push(`id: ${eventId}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return lines.join("\n") + "\n\n";
}

export async function sseStream(stream: SSEStreamingApi, generation: Generation, reason: string | null, since: number): Promise<void> {
  await stream.write(sseEvent("conversation", { conversation: generation.conversation, renewed: reason }));
  for await (const [kind, index, value] of generation.follow(since)) {
    if (stream.aborted) return; // the answer goes on being written; a new connection will pick it up
    if (kind === "text") await stream.write(sseEvent("text", { text: value }, index));
    else if (kind === "silence") await stream.write(": alive\n\n"); // an SSE comment: ignored by the browser, but it goes through
    else await stream.write(sseEvent((value as End).type, value as End));
  }
}

/** Chapter 18: the deletion promised in chapter 6, done for real. */
function purge(comptoir: Comptoir): void {
  try {
    logEvent("purge", { conversations: comptoir.conversations.purge() });
  } catch (error) {
    console.error("Purge of the conversations impossible:", error);
  }
}

/**
 * Chapter 18: a body that is too big is refused (413). In front of the Comptoir, Caddy does the same
 * (directive request_body, max_size); the check stays here, just in case. Hono's bodyLimit middleware
 * reads Content-Length, and also counts the bytes of a body sent in chunks, which has none (the fix of
 * chapter 19 in Python). `maximum` gives the limit of a path, read at each request in config.
 */
export function maxBodySize(maximum: (path: string) => number = () => config.MAX_REQUEST_SIZE): MiddlewareHandler {
  return (c, next) =>
    bodyLimit({ maxSize: maximum(c.req.path), onError: (c) => c.json({ error: "Message too long." }, 413) })(c, next);
}

export type Env = { Bindings: HttpBindings };

/**
 * The customer's address, seen from the Node server (or passed by the tests), then corrected by
 * X-Forwarded-For. trustedNeighbor (chapter 19, behind Caddy): the direct neighbor is a proxy, its
 * header is authoritative.
 */
export function address(c: Context<Env>, trustedNeighbor = false): string {
  const host = (c.env as Partial<HttpBindings> | undefined)?.incoming?.socket?.remoteAddress;
  const proxies = trustedNeighbor && host ? [...config.TRUSTED_PROXIES, host] : config.TRUSTED_PROXIES;
  return clientAddress(host, c.req.header("x-forwarded-for"), proxies);
}

export function limitRefusal(c: Context, limit: TooManyMessages): Response {
  c.header("Retry-After", String(Math.trunc(limit.wait) + 1));
  return c.json({ error: "Many messages in a short time: try again in a minute." }, 429);
}

export interface Server {
  app: Hono<Env>;
  comptoir: Comptoir;
  /** Starts the purge (at startup then every day); returns what stops it. */
  start(): () => void;
}

export function createApp(
  client?: StreamingClient,
  conversations?: Conversations,
  budget?: Budget,
  loadPrompt?: () => SystemPrompt,
): Server {
  const comptoir = new Comptoir(client, conversations, budget, loadPrompt);
  const app = new Hono<Env>();
  app.use("*", maxBodySize());

  // The page of the Python version, served as is (line endings normalized, as Python reads it).
  app.get("/", (c) => c.html(readFileSync(join(PYTHON, "comptoir", "pages", "comptoir.html"), "utf8").replace(/\r\n/g, "\n")));

  app.post("/api/messages", async (c) => {
    const parsed = Message.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Message refused." }, 422);
    const m = parsed.data;
    let launched;
    try {
      launched = comptoir.launch(m, address(c));
    } catch (error) {
      if (error instanceof Busy) return c.json({ error: "An answer is already in progress." }, 409);
      if (error instanceof TooManyMessages) return limitRefusal(c, error);
      throw error;
    }
    // X-Accel-Buffering: asks an nginx proxy to pass on each chunk without waiting to have a full
    // buffer. streamSSE adds Content-Type: text/event-stream and Cache-Control: no-cache.
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, (stream) => sseStream(stream, launched.generation, launched.reason, m.since));
  });

  /** The same conversation over WebSocket: a connection open in both directions. */
  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      const here = address(c as Context<Env>);
      let open = true;
      let queue = Promise.resolve(); // one message after another, like the loop of the Python version
      return {
        onMessage(event, ws) {
          queue = queue.then(async () => {
            let launched;
            let m: Message;
            try {
              const parsed = Message.safeParse(JSON.parse(String(event.data)));
              if (!parsed.success) throw parsed.error;
              m = parsed.data;
              launched = comptoir.launch(m, here);
            } catch {
              ws.send(JSON.stringify({ type: "error", message: "Message refused or answer already in progress." }));
              return;
            }
            ws.send(JSON.stringify({ type: "conversation", conversation: launched.generation.conversation, renewed: launched.reason }));
            for await (const [kind, index, value] of launched.generation.follow(m.since)) {
              if (!open) return; // the answer goes on being written; a new connection will pick it up
              if (kind === "text") ws.send(JSON.stringify({ type: "text", index, text: value }));
              else if (kind === "silence") ws.send(JSON.stringify({ type: "alive" }));
              else ws.send(JSON.stringify(value));
            }
          });
        },
        onClose() {
          open = false;
        },
      };
    }),
  );

  const start = (): (() => void) => {
    purge(comptoir);
    const timer = setInterval(() => purge(comptoir), PURGE_S * 1000);
    return () => clearInterval(timer);
  };
  return { app, comptoir, start };
}

/** The Node server: HTTP and WebSocket on the same port, then the daily purge. */
export function serveApp(
  { app, start }: Server = createApp(),
  port = Number(process.env.PORT ?? 8000),
  host = process.env.HOST ?? "127.0.0.1",
) {
  const websockets = new WebSocketServer({ noServer: true });
  const server = serve({ fetch: app.fetch, port, hostname: host, websocket: { server: websockets } }, (info) =>
    console.log(`Awa's Comptoir: http://${host}:${info.port}`),
  );
  const stopPurge = start();
  const stop = () => {
    stopPurge();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return server;
}

if (isMain(import.meta.url)) serveApp();
