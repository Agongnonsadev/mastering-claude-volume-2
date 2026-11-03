// The Comptoir, chapter 5 version: versioned prompt, tagged customer message, Awa's instructions during
// the conversation.

import type Anthropic from "@anthropic-ai/sdk";
import { type MessagesClient, type ReceivedMessage, textOf } from "./client.ts";
import { config } from "./config.ts";
import { type Cost, cost } from "./costs.ts";
import { logCall } from "./log.ts";
import { type SystemPrompt, customerMessage, load } from "./prompt.ts";

export const MAX_TOKENS = 2000;

type Request = Anthropic.MessageCreateParamsNonStreaming;
type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

/**
 * A system message added during the conversation, with the authority of the system prompt.
 *
 * It must immediately follow a user message, and be the last of the list or be followed by an
 * assistant answer. It does not break the cache of the beginning.
 */
export function operatorInstruction(text: string): Anthropic.SystemMessageParam {
  return { role: "system", content: text };
}

/**
 * Awa's documents at the top of the first message of the conversation (chapter 11).
 *
 * They are attached to each request, identically, and never recorded in the history: the beginning of
 * the request does not change from one turn to the next, nor from one customer to the next, and it can
 * therefore be read from the cache.
 */
export function attachKnowledge(
  messages: Anthropic.MessageParam[],
  blocks?: Anthropic.SearchResultBlockParam[] | null,
): Anthropic.MessageParam[] {
  const [first, ...rest] = messages;
  if (!blocks?.length || !first) return messages;
  const content = typeof first.content === "string" ? [{ type: "text" as const, text: first.content }] : first.content;
  return [{ ...first, content: [...blocks, ...content] } as Anthropic.MessageParam, ...rest];
}

export interface RequestOptions {
  history?: Anthropic.MessageParam[];
  instructions?: string[];
  prompt?: SystemPrompt;
  /** Chapter 11: automatic caching, whose breakpoint moves forward with the conversation. */
  cache?: boolean;
  /** Chapter 11: the search_result blocks of Awa's knowledge base. */
  knowledge?: Anthropic.SearchResultBlockParam[] | null;
  /**
   * Chapter 17: a model other than the one in config, to evaluate it; the effort of config then no
   * longer applies, since it was chosen for the Comptoir's model.
   */
  model?: string | null;
  /** Chapter 19: the effort of that particular model, if it has been measured; null for its default. */
  effort?: Effort | null;
}

export function buildRequest(question: string, options: RequestOptions = {}): Request {
  const prompt = options.prompt ?? load();
  const messages: Anthropic.MessageParam[] = [...(options.history ?? [])];
  messages.push({ role: "user", content: customerMessage(question) });
  // Placed right after the customer's message, Awa's instructions apply to its answer.
  messages.push(...(options.instructions ?? []).map(operatorInstruction));
  const request: Request = {
    model: options.model || config.MODEL,
    max_tokens: MAX_TOKENS,
    system: prompt.text,
    messages: attachKnowledge(messages, options.knowledge),
  };
  if (config.EFFORT && !options.model) request.output_config = { effort: config.EFFORT as Effort };
  if (options.effort) request.output_config = { effort: options.effort };
  if (options.cache) request.cache_control = { type: "ephemeral" };
  return request;
}

export async function answer(
  client: MessagesClient,
  question: string,
  options: RequestOptions = {},
): Promise<{ text: string; price: Cost; message: ReceivedMessage }> {
  const prompt = options.prompt ?? load();
  const request = buildRequest(question, { ...options, prompt });
  const message = await client.messages.create(request);
  const price = cost(request.model, message.usage);
  logCall(message._request_id, request.model, price, { prompt: prompt.id });
  return { text: textOf(message), price, message };
}
