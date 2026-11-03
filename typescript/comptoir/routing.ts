// The routed Comptoir: one router, three services, one trace per message (chapter 12).
//
// The manager is code, not a model: it asks the router for the category, then entrusts the message to the
// right worker, each with its model, its prompt and what it must see, nothing more.
// - information: the document assistant, with Claude Haiku 5.5 and Awa's base cached, without citations
//   or thinking: with citations, Haiku thinks anyway, and its answers degrade (measured in chapter 12); a
//   cut-off answer goes to the Comptoir, as, since chapter 18, does an answer that announces a pass-on to
//   Awa (comptoir/guard.ts);
// - order and other: the Comptoir of chapter 9, with its tools and the base; Claude Sonnet 5.5 in chapter
//   12, Claude Haiku 5.5 since the evaluation of chapter 17 (config.COMPTOIR_MODEL);
// - complaint: the complaints chain, which passes everything on to Awa.
//
// The exchanges handled outside the Comptoir are added to its history, in plain text: when the customer
// goes on to an order, the Comptoir knows the conversation.

import type Anthropic from "@anthropic-ai/sdk";
import type { Budget } from "./budget.ts";
import type { MessagesClient } from "./client.ts";
import { handle } from "./complaints.ts";
import { config } from "./config.ts";
import { answer as answerFromDocuments, loadPrompt } from "./doc_assistant.ts";
import { announcesPassOn } from "./guard.ts";
import type { Cache, Chunk } from "./knowledge.ts";
import { type Answer, ComptoirOrders } from "./orders.ts";
import { type SystemPrompt, customerMessage } from "./prompt.ts";
import { ROUTER_MODEL, route } from "./router.ts";
import type { Shop } from "./shop.ts";
import { Trace } from "./trace.ts";

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

export const DOCUMENTS_MODEL = config.DOCUMENTS_MODEL;

export interface RoutedReply {
  text: string;
  category: string;
  trace: Trace;
}

/**
 * Chapter 17: comptoirModel, promptVersion and documentsVersion can be changed to evaluate a variant; the
 * defaults are the shipped version (model: config.COMPTOIR_MODEL; prompt v5 since chapter 18, which tells
 * the Comptoir that it is an AI). comptoirEffort (chapter 19): null for config.COMPTOIR_EFFORT (the model's
 * default if it is empty). That effort was measured for the shipped model: it does not apply to another
 * model being evaluated (chapter 20, caught by Claude's review).
 */
export interface RoutingOptions {
  documentsModel?: string;
  cache?: Cache;
  comptoirModel?: string | null;
  promptVersion?: string;
  documentsVersion?: string;
  comptoirEffort?: Effort | null;
}

export class RoutedComptoir {
  readonly documentsModel: string;
  readonly cache: Cache;
  readonly comptoir: ComptoirOrders;
  readonly documentsPrompt: SystemPrompt;

  constructor(
    readonly client: MessagesClient,
    readonly shop: Shop,
    budget: Budget,
    readonly conversation: string,
    readonly base: Chunk[],
    { documentsModel = DOCUMENTS_MODEL, cache = "1h", comptoirModel = null, promptVersion = "v5", documentsVersion = "v1", comptoirEffort = null }: RoutingOptions = {},
  ) {
    this.documentsModel = documentsModel;
    this.cache = cache;
    this.comptoir = new ComptoirOrders(client, shop, budget, conversation, {
      promptVersion,
      knowledge: base,
      cache,
      model: comptoirModel || config.COMPTOIR_MODEL,
      effort: comptoirEffort || (comptoirModel === null ? (config.COMPTOIR_EFFORT as Effort | null) : null),
    });
    this.documentsPrompt = loadPrompt(documentsVersion);
  }

  orderInProgress(): boolean {
    return this.shop.summaries(this.conversation).some((s) => s.status === "pending");
  }

  private keepTheThread(text: string, reply: string): void {
    this.comptoir.history.push(
      { role: "user", content: customerMessage(text) },
      { role: "assistant", content: [{ type: "text", text: reply }] },
    );
  }

  async answer(text: string): Promise<RoutedReply> {
    const trace = new Trace();
    const decision = await trace.step("routing", ROUTER_MODEL, async (s) => {
      // The setting chosen by the measurement: Claude Haiku 5.5, no thinking.
      const d = await route(this.client, text, { orderInProgress: this.orderInProgress(), noThinking: true });
      s.record(d.cost, `${d.category} (by ${d.by})`);
      return d;
    });
    let category = decision.category;

    if (category === "information") {
      const reply = await this.information(text, trace);
      if (reply !== null) return { text: reply, category, trace };
      category = "information, fallback"; // a cut-off answer is not an answer: the Comptoir takes over
    }
    if (category === "complaint") {
      const result = await handle(this.client, text, this.shop, this.conversation, { trace });
      this.keepTheThread(text, result.reply);
      return { text: result.reply, category, trace };
    }
    const r = await trace.step("comptoir", this.comptoir.prompt.id, async (s) => {
      const before = this.comptoir.history.length;
      const reply = await this.comptoir.answer(text);
      s.record(turnCost(reply), `${this.comptoir.history.length - before} messages added`);
      return reply;
    });
    return { text: r.text, category, trace };
  }

  private async information(text: string, trace: Trace): Promise<string | null> {
    const r = await trace.step("documents", this.documentsModel, async (s) => {
      const reply = await answerFromDocuments(this.client, text, this.base, {
        prompt: this.documentsPrompt,
        cache: this.cache,
        mode: "routed",
        model: this.documentsModel,
        noThinking: true,
        withCitations: false,
      });
      s.record(reply.cost.dollars, reply.stop);
      return reply;
    });
    if (r.stop !== "end_turn" || !r.plainText) return null;
    if (announcesPassOn(r.plainText)) {
      // Chapter 18: the document assistant has no tool. A pass-on it announces will not take place: its
      // answer is not sent, the Comptoir, which has the tool, takes over.
      trace.add("guard", "code", 0, 0, "pass-on announced without a tool: handed over to the Comptoir");
      return null;
    }
    this.keepTheThread(text, r.plainText);
    return r.plainText;
  }
}

/** The cost of the calls made by the Comptoir during this turn (0 for a confirmation read by the code). */
const turnCost = (reply: Answer): number => (reply.turn ? reply.turn.cost : 0);
