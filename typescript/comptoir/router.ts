// The Comptoir's router: one message, one category, one service (chapter 12).
//
// The code first decides what it knows: a confirmation “YES 1234”, an order in progress. The model
// classifies the rest, with a structured output that can take only four values. It sees only the message:
// neither the tools, nor the base, nor the history. A booby-trapped message can therefore make it do
// nothing other than choose a category. The prompt is that of the Python version
// (python/comptoir/prompts/router_v1.md).

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type MessagesClient, textOf } from "./client.ts";
import { config } from "./config.ts";
import { cost } from "./costs.ts";
import { PYTHON } from "./launch.ts";
import { logCall } from "./log.ts";
import { CONFIRMATION } from "./orders.ts";
import { customerMessage } from "./prompt.ts";
import { repr } from "./python.ts";

export const CATEGORIES = ["complaint", "order", "information", "other"]; // by order of priority
export const ROUTER_MODEL = config.ROUTER_MODEL;
export const PROMPT = readFileSync(join(PYTHON, "comptoir", "prompts", "router_v1.md"), "utf8").replace(/\r\n?/g, "\n").trim();

export const SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...CATEGORIES] },
    reason: { type: "string" },
  },
  required: ["category", "reason"],
  additionalProperties: false,
};

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

/** A cut-off or unreadable answer: the message goes to the Comptoir, which can handle everything. */
export class RoutingImpossible extends Error {}

export interface Decision {
  category: string;
  reason: string;
  by: string; // “code” or the model's name
  cost: number;
}

export interface ClassifyOptions {
  model?: string;
  effort?: Effort | null;
  noThinking?: boolean;
}

export function routingRequest(message: string, { model = ROUTER_MODEL, effort = null, noThinking = false }: ClassifyOptions = {}): Anthropic.MessageCreateParamsNonStreaming {
  const outputConfig: Anthropic.OutputConfig = { format: { type: "json_schema", schema: SCHEMA } };
  if (effort) outputConfig.effort = effort;
  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    // Enough room for the thinking and the JSON: too low a ceiling cuts the answer off.
    max_tokens: 1000,
    system: PROMPT,
    messages: [{ role: "user", content: customerMessage(message) }],
    output_config: outputConfig,
  };
  if (noThinking) request.thinking = { type: "disabled" }; // accepted by Claude Haiku 5.5 (chapter 3)
  return request;
}

/** One call to the model. The category is validated by the code: outside the four, it is an error. */
export async function classify(client: MessagesClient, message: string, options: ClassifyOptions = {}): Promise<Decision> {
  const request = routingRequest(message, options);
  const response = await client.messages.create(request);
  const price = cost(request.model, response.usage);
  logCall(response._request_id, request.model, price, { prompt: "router-v1", stop_reason: response.stop_reason });
  if (response.stop_reason !== "end_turn") throw new RoutingImpossible(`answer stopped by ${response.stop_reason}`);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(textOf(response)) as Record<string, unknown>;
  } catch (error) {
    throw new RoutingImpossible("unreadable answer", { cause: error });
  }
  // The case of an enum value is not guaranteed: “Information” is an information.
  const category = String(data.category ?? "").toLowerCase();
  if (!CATEGORIES.includes(category)) throw new RoutingImpossible(`unknown category: ${repr(data.category)}`);
  if (!("reason" in data)) throw new Error("'reason'"); // a KeyError in Python: the structured output guarantees it
  return { category, reason: String(data.reason), by: request.model, cost: price.dollars };
}

/** What the code knows without asking: the confirmation of a summary. */
export function byCode(message: string): Decision | null {
  if (CONFIRMATION.test(message)) return { category: "order", reason: "confirmation of a summary", by: "code", cost: 0 };
  return null;
}

export async function route(client: MessagesClient, message: string, { orderInProgress = false, ...options }: ClassifyOptions & { orderInProgress?: boolean } = {}): Promise<Decision> {
  let decision: Decision;
  try {
    decision = byCode(message) ?? (await classify(client, message, options));
  } catch (error) {
    if (!(error instanceof RoutingImpossible)) throw error;
    // The most general service: the Comptoir, whose rules pass complaints on to Awa.
    return { category: "other", reason: `classification impossible (${error.message})`, by: "fallback", cost: 0 };
  }
  // During an order, what follows goes to the Comptoir, which has the history and the tools. A complaint
  // stays a complaint.
  if (orderInProgress && (decision.category === "information" || decision.category === "other")) {
    return { ...decision, category: "order", reason: `order in progress (${decision.category})` };
  }
  return decision;
}

/**
 * The most voted category; in case of a tie, the highest priority: when in doubt, a complaint goes to
 * Awa rather than getting lost.
 */
export function vote(decisions: Pick<Decision, "category">[]): string {
  const count = new Map<string, number>();
  for (const d of decisions) count.set(d.category, (count.get(d.category) ?? 0) + 1);
  const best = Math.max(...count.values());
  const winner = CATEGORIES.find((c) => count.get(c) === best);
  if (winner === undefined) throw new Error("None of the four categories has the most votes."); // StopIteration in Python
  return winner;
}

/** The same classification, several times in parallel (parallelization by voting). */
export async function routeByVote(client: MessagesClient, message: string, votes = 3, options: ClassifyOptions = {}): Promise<[string, Decision[]]> {
  const decisions = await Promise.all(Array.from({ length: votes }, () => classify(client, message, options)));
  return [vote(decisions), decisions];
}
