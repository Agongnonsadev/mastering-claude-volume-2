// The Comptoir that takes orders: tools, official summary, confirmation by the customer (chapter 9).
//
// The approval pattern is simple and does not depend on the model:
// 1. Claude prepares a summary with the order_prepare tool;
// 2. the code itself shows the official summary, with the total and a four-digit code;
// 3. the customer replies “YES 1234”; this message is read by the code, not by Claude;
// 4. the code creates the order, only once.

import type Anthropic from "@anthropic-ai/sdk";
import { buildRequest } from "./assistant.ts";
import type { Budget } from "./budget.ts";
import type { MessagesClient } from "./client.ts";
import { announcesPassOn } from "./guard.ts";
import { type Cache, type Chunk, resultBlocks } from "./knowledge.ts";
import { logEvent } from "./log.ts";
import { type Turn, converse } from "./loop.ts";
import { type SystemPrompt, customerMessage, load } from "./prompt.ts";
import { type Shop, ShopRefusal, type Summary } from "./shop.ts";
import { TOOLS, Tools } from "./tools.ts";

export const PROMPT_VERSION = "v2";
export const CONFIRMATION = /^\s*yes\s+(\d{4})\s*[.!]?\s*$/i;

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

/** 11000 -> “11,000”, like f"{n:,}" in Python. */
const thousands = (n: number): string => n.toLocaleString("en-US");

/** The summary the customer sees: written by the code, from the shop's data. */
export function renderSummary(summary: Summary): string {
  const lines = summary.lines.map((l) => `  ${l.quantity} × ${l.product}: ${thousands(l.amount)} FCFA`);
  const fee = summary.delivery_fee;
  return [
    "Your order summary",
    ...lines,
    `  Delivery (${summary.neighborhood}, ${summary.planned_delivery}): ${fee === 0 ? "free" : `${fee} FCFA`}`,
    `  Total: ${thousands(summary.total_fcfa)} FCFA`,
    `To confirm, reply exactly: YES ${summary.confirmation_code}`,
  ].join("\n");
}

export interface Answer {
  text: string; //                         what the customer reads
  newMessages: Anthropic.MessageParam[];
  turn: Turn | null; //                     null: the answer comes from the code (confirmation)
}

export interface ComptoirOptions {
  promptVersion?: string;
  /** Chapter 11: Awa's base as knowledge. */
  knowledge?: Chunk[] | null;
  /**
   * Chapter 11: "1h", the beginning common to all customers (tools, prompt, base) is kept one hour; the
   * end of each conversation stays in the automatic 5-minute cache.
   */
  cache?: Cache;
  /** Chapter 17: null for the model of config; another one, to evaluate it. */
  model?: string | null;
  /**
   * Chapter 19: the effort of that model, constant for the whole conversation (changing it would
   * invalidate the cache); null for the model's default.
   */
  effort?: Effort | null;
}

/** A conversation with the Comptoir, tools included. The history is append-only. */
export class ComptoirOrders {
  readonly prompt: SystemPrompt;
  readonly history: Anthropic.MessageParam[] = [];
  private readonly cache: boolean;
  private readonly blocks: Anthropic.SearchResultBlockParam[] | null;
  private readonly model: string | null;
  private readonly effort: Effort | null;

  constructor(
    readonly client: MessagesClient,
    readonly shop: Shop,
    readonly budget: Budget,
    readonly conversation: string,
    { promptVersion = PROMPT_VERSION, knowledge = null, cache = false, model = null, effort = null }: ComptoirOptions = {},
  ) {
    this.prompt = load(promptVersion);
    this.cache = Boolean(cache);
    // The blocks are built once and for all: identical from one turn to the next.
    this.blocks = knowledge?.length ? resultBlocks(knowledge, cache) : null;
    this.model = model;
    this.effort = effort;
  }

  request(text: string): Anthropic.MessageCreateParamsNonStreaming {
    const request = buildRequest(text, {
      history: this.history, prompt: this.prompt, cache: this.cache, knowledge: this.blocks,
      model: this.model, effort: this.effort,
    });
    // The tools do not change during a conversation: modifying them would invalidate the preserved
    // thinking of all the previous turns (chapter 6).
    request.tools = TOOLS;
    return request;
  }

  async answer(text: string): Promise<Answer> {
    const confirmation = CONFIRMATION.exec(text);
    let answer: Answer;
    if (confirmation) {
      answer = this.confirm(confirmation[1]!, text);
    } else {
      const turn = await converse(this.client, this.request(text), new Tools(this.shop, this.conversation), this.budget,
        this.conversation, this.prompt.id);
      if (turn.stop?.code === "refusal") {
        // As in chapter 8: the refused answer is thrown away, and the turn does not enter the history.
        return { text: turn.stop.forCustomer, newMessages: [], turn };
      }
      let visible = turn.text;
      if (announcesPassOn(turn.text) && !turn.execution.passedOn.length) {
        // Chapter 18: the customer read “I'm passing your request on to Awa”; the code keeps the promise the
        // model made without calling the tool. Awa receives the customer's message, as is.
        const request = this.shop.passOn(this.conversation, "other",
          `Pass-on announced to the customer by the Comptoir. Their message: ${[...text].slice(0, 300).join("")}`);
        turn.execution.passedOn.push(request);
        logEvent("guard", { rule: "announced_pass_on", request: request.request });
      }
      if (turn.execution.summary) visible = `${visible}\n\n${renderSummary(turn.execution.summary)}`;
      const question: Anthropic.MessageParam = { role: "user", content: customerMessage(text) };
      answer = { text: visible, newMessages: [question, ...turn.newMessages], turn };
    }
    this.history.push(...answer.newMessages);
    return answer;
  }

  /** The confirmation does not go through Claude: the code reads the message and creates the order. */
  private confirm(code: string, text: string): Answer {
    let visible: string;
    try {
      const order = this.shop.confirm(this.conversation, code);
      visible = order.already_recorded
        ? `Your order ${order.order} was already recorded: nothing has been added.`
        : `Your order ${order.order} is recorded, for a total of ${thousands(order.total_fcfa)} FCFA. ` +
          "Awa will contact you about delivery. Thank you!";
    } catch (refusal) {
      if (!(refusal instanceof ShopRefusal)) throw refusal;
      visible = `I could not confirm: ${refusal.message}`;
    }
    // The exchange enters the history, so that Claude knows, at the next turn, what happened.
    const exchange: Anthropic.MessageParam[] = [
      { role: "user", content: customerMessage(text) },
      { role: "assistant", content: [{ type: "text", text: visible }] },
    ];
    return { text: visible, newMessages: exchange, turn: null };
  }
}
