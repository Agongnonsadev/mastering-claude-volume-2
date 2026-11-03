// The shipped Comptoir, behind its channels (chapter 19): the web chat and WhatsApp.
//
// Until now, the web chat of chapter 6 talked to an assistant without tools, and the routed Comptoir only
// lived in the test harnesses, a conversation in memory. Online, each message:
// 1. finds its conversation in the database (comptoir/conversations.ts), or opens one;
// 2. reserves its cost in the budget, for the whole message;
// 3. goes through the routed Comptoir (chapter 12), with its tools, its confirmation by code and its guards;
// 4. adds to the conversation what the turn produced, without rewriting anything, then settles the real cost;
// 5. leaves in the log a “message” event: channel, category, cost of all the steps, duration.
//    That is what the dashboard reads: the cost per conversation, the latency per message.
//
// Why the budget at the level of the message: since the router, the routing, the document assistant and the
// complaints chain call Claude without going through comptoir/call.ts; the budget of chapter 8 saw only the
// calls of the Comptoir itself. So the service reserves a ceiling per message, with the customer's quota and
// that of their group (their address on the web, their number on WhatsApp), then settles what the trace
// really cost, all steps included.
//
// One message at a time for the whole Comptoir: the messages wait their turn in a queue. The SQLite databases
// are shared, and one customer's turn must not cross another's. At 40 conversations a day, waiting is rare;
// beyond that, a database such as PostgreSQL.

import Anthropic from "@anthropic-ai/sdk";
import { Budget } from "./budget.ts";
import type { MessagesClient } from "./client.ts";
import type { Conversations, HistoryMessage } from "./conversations.ts";
import { ComptoirError, UNAVAILABLE, diagnose } from "./errors.ts";
import type { Chunk } from "./knowledge.ts";
import { logEvent } from "./log.ts";
import { load } from "./prompt.ts";
import { pythonJson } from "./python.ts";
import { round } from "./rounding.ts";
import { RoutedComptoir, type RoutingOptions } from "./routing.ts";
import type { Shop } from "./shop.ts";

// The ceiling reserved for a message, before its cost is known: generous compared with the measured costs
// ($0.0009 per message on average on the shipped Comptoir, in chapter 17; a complaint, drafted by Claude
// Sonnet 5.5, a few thousandths of a dollar).
export const MESSAGE_RESERVE = 0.02;
export const BASE_TOKENS = 7000; // Awa's base, attached to each request (about 6,900 tokens, chapter 17)

export interface Turn {
  text: string;
  conversation: string;
  category: string;
  costDollars: number;
  durationMs: number;
  error: string | null;
}

const turn = (text: string, conversation: string, category: string, others: Partial<Turn> = {}): Turn => ({
  text, conversation, category, costDollars: 0, durationMs: 0, error: null, ...others,
});

/**
 * The size of the context, roughly: about 3 characters per token in French, plus the base. It is only used
 * to close a conversation that is too long (config.MAX_CONTEXT).
 */
export const estimateTokens = (history: unknown[]): number => Math.floor([...pythonJson(history)].length / 3) + BASE_TOKENS;

export class ComptoirService {
  readonly prompt: string;
  private queue: Promise<unknown> = Promise.resolve();

  /** options: those of RoutedComptoir (promptVersion, comptoirEffort, cache…), for a variant. */
  constructor(
    readonly client: MessagesClient,
    readonly shop: Shop,
    readonly budget: Budget,
    readonly conversations: Conversations,
    readonly knowledge: Chunk[],
    readonly options: RoutingOptions = {},
  ) {
    this.prompt = load(options.promptVersion ?? "v5").id;
  }

  /** [the conversation to use, the reason if the old one was closed, true if it is new]. */
  open(conversation: string | null | undefined): [string, string | null, boolean] {
    let reason: string | null = null;
    if (conversation && this.conversations.exists(conversation)) {
      reason = this.conversations.closingReason(conversation, this.prompt);
      if (reason === null) return [conversation, null, false];
    } else if (conversation) {
      reason = "unknown";
    }
    return [this.conversations.create(this.prompt), reason, true];
  }

  /** One message after the other: each answer waits for the previous one to be finished. */
  answer(conversation: string, text: string, channel: string, group: string | null = null): Promise<Turn> {
    const next = this.queue.then(() => this.answerNow(conversation, text, channel, group));
    this.queue = next.catch(() => {});
    return next;
  }

  private async answerNow(conversation: string, text: string, channel: string, group: string | null): Promise<Turn> {
    const decision = this.budget.reserve(conversation, MESSAGE_RESERVE, group);
    if (!decision.accepted) {
      logEvent("over_budget", { reason: decision.reason, customer: conversation, channel });
      return turn(UNAVAILABLE, conversation, "over_budget", { error: decision.reason });
    }
    const history: HistoryMessage[] = this.conversations.history(conversation);
    // The budget of each call is kept here, at the level of the message: the Comptoir receives a blank budget,
    // which refuses nothing and counts nothing twice.
    const comptoir = new RoutedComptoir(this.client, this.shop, new Budget(":memory:"), conversation, this.knowledge, this.options);
    comptoir.comptoir.history.push(...history);
    const start = performance.now();
    let answer;
    try {
      answer = await comptoir.answer(text);
    } catch (error) {
      // The router, the document assistant and the complaints call Claude outside comptoir/call.ts (chapter 12):
      // their errors arrive raw. So the diagnosis of chapter 8 is made here too.
      if (!(error instanceof ComptoirError || error instanceof Anthropic.APIError)) throw error;
      const diagnostic = error instanceof ComptoirError ? error.diagnostic : diagnose(error);
      const duration = round(performance.now() - start);
      // The cost of a failure is not known to the code: the reservation stays, the Console is authoritative.
      logEvent("message", { channel, conversation, error: diagnostic.code, origin: diagnostic.origin, duration_ms: duration });
      return turn(diagnostic.forCustomer, conversation, "error", { durationMs: duration, error: diagnostic.code });
    }
    const added = comptoir.comptoir.history.slice(history.length);
    if (added.length) this.conversations.addTurn(conversation, added, estimateTokens(comptoir.comptoir.history));
    const cost = answer.trace.cost; // all the steps, from the trace of chapter 12
    this.budget.settle(decision.reservation!, cost);
    logEvent("message", {
      channel, conversation, category: answer.category, cost_dollars: round(cost, 6), duration_ms: answer.trace.durationMs, steps: answer.trace.steps.length,
    });
    return turn(answer.text, conversation, answer.category, { costDollars: cost, durationMs: answer.trace.durationMs });
  }
}
