// The Comptoir online (chapter 19): the web chat and WhatsApp, on the shipped Comptoir.
//
//     npx tsx comptoir/online.ts --port 8019          (locally, from the typescript/ folder)
//
// What changes compared with the chat of chapter 6 (comptoir/web.ts, kept for its streaming example):
// - both channels go through the routed Comptoir, with its tools, its confirmation by code and its guards
//   (comptoir/service.ts); the answer arrives in one block, not word by word, because the tool loop must
//   finish before we know what was done;
// - one message at a time for the whole server: what touches the databases (opening a conversation, setting
//   aside a duplicate, answering, purging) waits its turn in a single queue, the Comptoir's “thread”, like
//   the single thread of the Python version;
// - WhatsApp: webhook verified and signed, answer through Meta's API, number kept in the directory only;
// - the dashboard (/dashboard, with a token) and the health of the service (/health);
// - the monitoring of chapter 18, if it is turned on, alongside the answer;
// - the limits and the purge of chapter 18, for both channels.

import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Budget } from "./budget.ts";
import type { MessagesClient } from "./client.ts";
import { config } from "./config.ts";
import { Conversations } from "./conversations.ts";
import { load as loadLog, toHtml } from "./dashboard.ts";
import { UNAVAILABLE } from "./errors.ts";
import { type Chunk, loadKnowledge } from "./knowledge.ts";
import { PYTHON, isMain } from "./launch.ts";
import { RateLimiter } from "./limits.ts";
import { logEvent } from "./log.ts";
import { monitor } from "./monitoring.ts";
import { round } from "./rounding.ts";
import type { RoutingOptions } from "./routing.ts";
import { ComptoirService } from "./service.ts";
import { Shop } from "./shop.ts";
import { Generation } from "./streaming.ts";
import { type Env, KEEP_S, Message, TooManyMessages, address, limitRefusal, maxBodySize, sseStream } from "./web.ts";
import * as whatsapp from "./whatsapp.ts";

export const PURGE_S = 24 * 3600;

const nameOf = (error: unknown): string => (error as object | null)?.constructor?.name ?? typeof error;

/** What can be given to the server (the tests give everything); the rest is created at first use. */
export interface Settings {
  client?: MessagesClient;
  shop?: Shop;
  budget?: Budget;
  conversations?: Conversations;
  knowledge?: Chunk[];
  directory?: whatsapp.Directory;
  sender?: Pick<whatsapp.Sender, "send">;
  /** The options of the routed Comptoir (promptVersion, comptoirEffort, cache…), for a variant. */
  options?: RoutingOptions;
}

/** The server's state: the service, the channels, the limits, the answers in progress on the web. */
export class Online {
  readonly generations = new Map<string, Generation>();
  readonly messagesPerMinute = new RateLimiter(config.MESSAGES_PER_MINUTE_LIMIT, 60);
  readonly conversationsPerHour = new RateLimiter(config.CONVERSATIONS_PER_HOUR_LIMIT, 3600);
  private thread: Promise<unknown> = Promise.resolve();
  private readonly monitorings = new Set<Promise<void>>();
  private _service: ComptoirService | null = null;
  private stopped = false;

  constructor(private readonly settings: Settings = {}) {}

  // Created at first use: importing this module reads neither the key nor the databases.
  get client(): MessagesClient {
    return (this.settings.client ??= new Anthropic({ timeout: config.TIMEOUT_S * 1000, maxRetries: config.RETRIES }));
  }

  get service(): ComptoirService {
    const s = this.settings;
    return (this._service ??= new ComptoirService(
      this.client, s.shop ?? new Shop(config.SHOP), s.budget ?? new Budget(config.BUDGET_DB),
      s.conversations ?? new Conversations(config.CONVERSATIONS), s.knowledge ?? loadKnowledge(), s.options ?? {},
    ));
  }

  get directory(): whatsapp.Directory {
    return (this.settings.directory ??= new whatsapp.Directory(config.CONVERSATIONS));
  }

  get sender(): Pick<whatsapp.Sender, "send"> {
    return (this.settings.sender ??= new whatsapp.Sender(config.WHATSAPP_TOKEN, config.WHATSAPP_API_VERSION));
  }

  /** A task in the Comptoir's thread: it waits for the previous ones to be finished. */
  inTheThread<T>(task: () => T | Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("The server is stopping."));
    const next = this.thread.then(task);
    this.thread = next.catch(() => {});
    return next;
  }

  /** Wait for the end of everything in the thread (for the tests, and before stopping). */
  async waitForTheThread(): Promise<void> {
    let before: Promise<unknown>;
    do {
      before = this.thread;
      await before;
    } while (before !== this.thread);
  }

  /** Wait for the end of the monitoring examinations in progress. */
  async waitForTheMonitoring(): Promise<void> {
    await Promise.all(this.monitorings);
  }

  /** The queued messages are finished before stopping: Meta has already received its 200 and will not send them again. */
  async stop(): Promise<void> {
    await this.waitForTheThread();
    this.stopped = true;
  }

  limit(limiter: RateLimiter, reason: string, key: string): void {
    const wait = limiter.accept(key);
    if (wait !== null) {
      logEvent("limit", { reason, address: key });
      throw new TooManyMessages(reason, wait);
    }
  }

  monitor(text: string, conversation: string, channel: string, group: string | null = null): void {
    if (!config.MONITORING_FILTER) return;
    // Alongside the answer: the call to Claude does not delay it. The spending, for its part, is counted in
    // the Comptoir's thread, like everything that touches the databases (chapter 20).
    const examination = monitor(this.client, text, conversation, channel).then(async ([, dollars]) => {
      if (!dollars) return;
      await this.inTheThread(() => this.countMonitoring(conversation, group, dollars, channel)).catch(() => {
        // the server is stopping: the call stays in the log, with its cost
      });
    });
    this.monitorings.add(examination);
    void examination.finally(() => this.monitorings.delete(examination));
  }

  countMonitoring(conversation: string, group: string | null, dollars: number, channel: string): void {
    try {
      this.service.budget.add(conversation, dollars, group);
    } catch (error) {
      // An error here surfaces nowhere: it is logged (Claude's review, chapter 20).
      logEvent("monitoring_impossible", { conversation, channel, error: nameOf(error), cost_dollars: round(dollars, 6) });
      return;
    }
    logEvent("monitoring", { conversation, channel, cost_dollars: round(dollars, 6) });
  }

  // --- The web chat ------------------------------------------------------------------------------

  async launchWeb(m: Message, here: string): Promise<[Generation, string | null]> {
    const limit = performance.now() - KEEP_S * 1000;
    for (const [key, g] of this.generations) if (g.finishedAt !== null && g.finishedAt < limit) this.generations.delete(key);
    let already = this.generations.get(m.message_id);
    if (already) return [already, null]; // the same message, sent again after a cut: it is reattached
    this.limit(this.messagesPerMinute, "messages_per_minute", here);
    const [conversation, reason] = await this.inTheThread(() => this.openWeb(m.conversation ?? null, here));
    already = this.generations.get(m.message_id);
    if (already) return [already, null]; // arrived twice during the wait: it is reattached to the first one
    const generation = new Generation(conversation);
    this.generations.set(m.message_id, generation);
    generation.task = this.produceWeb(generation, m.text, here);
    return [generation, reason];
  }

  /** In the Comptoir's thread: does the conversation exist, open one, count the new ones. */
  private openWeb(conversation: string | null, here: string): [string, string | null] {
    if (!conversation || !this.service.conversations.exists(conversation)) this.limit(this.conversationsPerHour, "conversations_per_hour", here);
    const [opened, reason] = this.service.open(conversation);
    return [opened, reason];
  }

  private async produceWeb(generation: Generation, text: string, here: string): Promise<void> {
    this.monitor(text, generation.conversation, "web", `address:${here}`);
    let turn;
    try {
      turn = await this.inTheThread(() => this.service.answer(generation.conversation, text, "web", `address:${here}`));
    } catch (error) {
      console.error("Answer impossible:", error);
      generation.finish({ type: "error", message: UNAVAILABLE });
      return;
    }
    generation.add(turn.text);
    generation.finish({ type: "end", truncated: false });
  }

  // --- WhatsApp ---------------------------------------------------------------------------------

  /** In the Comptoir's thread: one answer per message, sent through Meta's API. */
  async handleWhatsapp(message: whatsapp.IncomingMessage): Promise<void> {
    try {
      await this.handleOneMessage(message);
    } catch (error) {
      // An error in the thread surfaces nowhere: without this trace, the customer would wait in silence.
      console.error("WhatsApp message not handled:", error);
      logEvent("whatsapp_processing", { error: nameOf(error) });
    }
  }

  private async handleOneMessage(message: whatsapp.IncomingMessage): Promise<void> {
    if (!this.directory.new(message.id)) return; // Meta retries: a message is handled only once
    const pseudo = whatsapp.pseudonym(message.number, config.PSEUDONYM_SALT);
    try {
      this.limit(this.messagesPerMinute, "messages_per_minute", pseudo);
    } catch (error) {
      if (error instanceof TooManyMessages) return; // a script, not a customer: no answer, no cost
      throw error;
    }
    const [conversation, , isNew] = this.service.open(this.directory.conversation(pseudo));
    this.directory.link(pseudo, message.number, conversation);
    let text: string;
    if (message.type !== "text" || !message.text) {
      text = whatsapp.NOT_TEXT;
    } else {
      this.monitor(message.text, conversation, "whatsapp", pseudo);
      text = (await this.service.answer(conversation, message.text, "whatsapp", pseudo)).text;
    }
    if (isNew) text = `${whatsapp.AI_DISCLOSURE}\n\n${text}`;
    try {
      await this.sender.send(message.businessNumber, message.number, text);
      logEvent("whatsapp_send", { conversation });
    } catch (error) {
      logEvent("whatsapp_send", { conversation, error: nameOf(error), status: (error as { status?: number }).status ?? null });
    }
  }

  purge(): Record<string, number> {
    const result: Record<string, number> = this.service.shop.purge(
      config.REQUEST_RETENTION_DAYS, config.NAME_RETENTION_DAYS, config.SUMMARY_RETENTION_DAYS,
    );
    result.conversations = this.service.conversations.purge();
    result.whatsapp_customers = this.directory.purge(config.RETENTION_DAYS);
    return result;
  }
}

const validToken = (authorization: string | undefined): boolean => Boolean(config.DASHBOARD_TOKEN) && authorization === `Bearer ${config.DASHBOARD_TOKEN}`;

export interface OnlineServer {
  app: Hono<Env>;
  state: Online;
  /** Starts the purge (at startup then every day); returns what stops it. */
  start(): () => void;
}

/** trustedProxy: behind Caddy, the only one to reach the server, its X-Forwarded-For header is authoritative. */
export function createApp(settings: Settings = {}, { trustedProxy = false } = {}): OnlineServer {
  const state = new Online(settings);
  const app = new Hono<Env>();

  // Chapter 18: a body that is too big is refused, even sent in chunks. WhatsApp has its own limit: Meta sends
  // notifications of up to 3 MB.
  app.use("*", maxBodySize((path) => (path === "/whatsapp" ? config.MAX_WEBHOOK_SIZE : config.MAX_REQUEST_SIZE)));

  // The page of the Python version, served as is (line endings normalized, as Python reads it).
  app.get("/", (c) => c.html(readFileSync(join(PYTHON, "comptoir", "pages", "comptoir.html"), "utf8").replace(/\r\n/g, "\n")));

  app.post("/api/messages", async (c) => {
    const parsed = Message.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Message refused." }, 422);
    const m = parsed.data;
    let launched: [Generation, string | null];
    try {
      launched = await state.launchWeb(m, address(c, trustedProxy));
    } catch (error) {
      if (error instanceof TooManyMessages) return limitRefusal(c, error);
      throw error;
    }
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, (stream) => sseStream(stream, launched[0], launched[1], m.since));
  });

  /** Meta's verification: return hub.challenge if the token is the right one. */
  app.get("/whatsapp", (c) => {
    if (config.WHATSAPP_VERIFY_TOKEN && c.req.query("hub.mode") === "subscribe" && c.req.query("hub.verify_token") === config.WHATSAPP_VERIFY_TOKEN) {
      return c.text(c.req.query("hub.challenge") ?? "");
    }
    return c.text("Refused", 403);
  });

  app.post("/whatsapp", async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (!whatsapp.validSignature(body, c.req.header("x-hub-signature-256"), config.WHATSAPP_APP_SECRET)) {
      logEvent("whatsapp_invalid_signature");
      return c.text("Invalid signature", 401);
    }
    if (!config.PSEUDONYM_SALT) {
      // Without a salt, a number's fingerprint is found by trying all the possible numbers: nothing is handled.
      // Meta, which receives 503, sends the notification again for 7 days (chapter 20).
      logEvent("whatsapp_not_configured", { missing: "COMPTOIR_PSEUDONYM_SALT" });
      return c.text("WhatsApp is not configured yet", 503);
    }
    let incoming: whatsapp.IncomingMessage[];
    try {
      incoming = whatsapp.incomingMessages(JSON.parse(new TextDecoder().decode(body)));
    } catch {
      return c.text("Unreadable body", 400);
    }
    // Entrusted to the Comptoir's thread, without waiting for it: Meta receives its 200 right away. The
    // duplicate is set aside in the thread, like everything that touches the databases.
    for (const message of incoming) void state.inTheThread(() => state.handleWhatsapp(message)).catch(() => {});
    return c.text("ok");
  });

  app.get("/dashboard", (c) => {
    if (!validToken(c.req.header("authorization"))) return c.text("Restricted access", 401);
    return c.html(toHtml(loadLog()));
  });

  app.get("/health", (c) => c.json({ state: "ok" }));

  const purgeOnce = async (): Promise<void> => {
    try {
      logEvent("purge", await state.inTheThread(() => state.purge()));
    } catch (error) {
      console.error("Purge impossible:", error);
    }
  };
  const start = (): (() => void) => {
    void purgeOnce();
    const timer = setInterval(() => void purgeOnce(), PURGE_S * 1000);
    return () => clearInterval(timer);
  };
  return { app, state, start };
}

/** The Node server, then the daily purge; when stopping, the queued messages are finished first. */
export function serveOnline(server: OnlineServer, port: number, host: string) {
  const http = serve({ fetch: server.app.fetch, port, hostname: host }, (a) => console.log(`The Comptoir online: http://${host}:${a.port}`));
  const stopThePurge = server.start();
  const stop = (): void => {
    stopThePurge();
    // compose.yaml gives the container 30 seconds to stop.
    http.close();
    void server.state.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return http;
}

if (isMain(import.meta.url)) {
  const { values: args } = parseArgs({
    options: {
      port: { type: "string", default: "8019" },
      host: { type: "string", default: "127.0.0.1" },
      // Behind Caddy, which terminates HTTPS: trust its X-Forwarded-For header (one proxy).
      "behind-a-proxy": { type: "boolean", default: false },
    },
  });
  serveOnline(createApp({}, { trustedProxy: args["behind-a-proxy"] }), Number(args.port), args.host);
}
