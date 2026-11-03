// A call to Claude that withstands failures and respects the budget (chapter 8).
//
// In order: count the input (free), reserve the maximum cost, call, record in the log what happened,
// settle the real cost, and translate any failure into a diagnosis.

import Anthropic from "@anthropic-ai/sdk";
import { performance } from "node:perf_hooks";
import type { Budget } from "./budget.ts";
import { type MessagesClient, type ReceivedMessage, textOf } from "./client.ts";
import { config } from "./config.ts";
import { type Cost, cacheDuration, cost, maxCost } from "./costs.ts";
import { ComptoirError, type Diagnostic, UNAVAILABLE, diagnose, diagnoseStop } from "./errors.ts";
import { logCall, logEvent } from "./log.ts";

type Request = Anthropic.MessageCreateParamsNonStreaming;

/** The request parameters that the counting tool accepts too. */
export const COUNTING_FIELDS = ["model", "messages", "system", "tools", "tool_choice", "thinking", "output_config"] as const;

/** The counting request: only the fields countTokens accepts (not max_tokens, for example). */
export function countingRequest(request: Request): Anthropic.MessageCountTokensParams {
  return Object.fromEntries(
    Object.entries(request).filter(([key]) => (COUNTING_FIELDS as readonly string[]).includes(key)),
  ) as Anthropic.MessageCountTokensParams;
}

export class OverBudget extends ComptoirError {}

/** The Comptoir's client: timeout and retries set, rather than the SDK's defaults. */
export function makeClient(): Anthropic {
  return new Anthropic({ timeout: config.TIMEOUT_S * 1000, maxRetries: config.RETRIES });
}

export async function estimateMaximum(client: MessagesClient, request: Request): Promise<number> {
  const count = await client.messages.countTokens(countingRequest(request));
  // With a cache breakpoint, the input may be written to the cache: dearer than the input (chapter 11).
  return maxCost(request.model, count.input_tokens, request.max_tokens, cacheDuration(request));
}

export interface Reply {
  message: ReceivedMessage;
  text: string;
  cost: Cost;
  stop: Diagnostic | null; // null: the answer stopped normally
  alert: boolean; //          the daily or monthly budget is approaching its ceiling
}

export async function callClaude(
  client: MessagesClient,
  request: Request,
  budget: Budget,
  customerId: string,
  prompt: string | null = null,
): Promise<Reply> {
  let maximum: number;
  try {
    maximum = await estimateMaximum(client, request);
  } catch (error) { // counting fails as the call would fail: same diagnosis
    const d = diagnose(error);
    logEvent("counting_impossible", { customer: customerId, error: d.code, origin: d.origin });
    throw new ComptoirError(d, { cause: error });
  }
  const decision = budget.reserve(customerId, maximum);
  if (!decision.accepted) {
    logEvent("over_budget", { reason: decision.reason, customer: customerId });
    throw new OverBudget({
      code: decision.reason!, retry: false, origin: "account", forCustomer: UNAVAILABLE,
      forYao: `Call refused by the Comptoir's budget (${decision.reason}).`, waitS: null,
    });
  }

  const start = performance.now();
  let message: ReceivedMessage;
  try {
    message = await client.messages.create(request);
  } catch (error) {
    const d = diagnose(error);
    const requestId = error instanceof Anthropic.APIError ? error.requestID : null;
    logCall(requestId, request.model, null, {
      prompt, customer: customerId, error: d.code, origin: d.origin, duration_ms: Math.round(performance.now() - start),
    });
    // An error returned by the API is not billed; a network cut can be (the request may have gone
    // through without the answer arriving): the reserve is then kept.
    if (error instanceof Anthropic.APIError && error.status !== undefined) budget.release(decision.reservation!);
    throw new ComptoirError(d, { cause: error });
  }

  const price = cost(request.model, message.usage);
  budget.settle(decision.reservation!, price.dollars);
  const stop = diagnoseStop(message);
  logCall(message._request_id, request.model, price, {
    prompt, customer: customerId, stop_reason: message.stop_reason, duration_ms: Math.round(performance.now() - start),
    error: stop?.code, origin: stop?.origin,
  });
  return { message, text: textOf(message), cost: price, stop, alert: budget.onAlert() };
}
