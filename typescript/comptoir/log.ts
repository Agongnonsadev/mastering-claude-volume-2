// Record each call in a log: enough to find a request again and to follow the costs (chapter 2).
//
// One JSON line per call, in the same format as the Python version: the same dashboard reads both. It
// holds the request ID (to give to Anthropic's support in case of a problem), the model, the tokens and
// the cost. Never the API key, never the content of the customers' messages.
//
// Since chapter 8, each line can also carry what is needed to analyze failures: the stop reason, the
// duration, the error code and its origin, the conversation.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import type { Cost } from "./costs.ts";
import { round } from "./rounding.ts";

/** What a line can carry in addition; null or missing values are not written. */
export type Details = Record<string, unknown>;

/** The date in UTC, to the second, as Python writes it: 2026-10-22T08:15:00+00:00. */
const now = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

function write(line: Record<string, unknown>, path?: string): Record<string, unknown> {
  const file = path ?? config.LOG;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
  return line;
}

function add(line: Record<string, unknown>, details: Details): Record<string, unknown> {
  for (const [key, value] of Object.entries(details)) if (value !== null && value !== undefined) line[key] = value;
  return line;
}

/**
 * Records a call. cost=null: the call did not go through to the end (stream cut, error). Its real cost
 * is not known to the code; the Console is authoritative.
 *
 * details: prompt (version and fingerprint of the system prompt, chapter 5), and since chapter 8
 * stop_reason, duration_ms, error, origin, customer…
 */
export function logCall(
  requestId: string | null | undefined,
  model: string,
  cost: Cost | null,
  { prompt, ...details }: Details = {},
  path?: string,
): Record<string, unknown> {
  const line: Record<string, unknown> = {
    date: now(),
    request: requestId ?? null,
    model,
    prompt: prompt ?? null,
    input_tokens: cost ? cost.input : null,
    cache_write_tokens: cost ? cost.cacheWrite : null,
    cache_read_tokens: cost ? cost.cacheRead : null,
    output_tokens: cost ? cost.output : null,
    thinking_tokens: cost ? cost.thinking : null,
    cost_dollars: cost ? round(cost.dollars, 6) : null,
  };
  if (cost?.searches) line.web_searches = cost.searches; // chapter 10
  if (!cost) line.interrupted = true;
  return write(add(line, details), path);
}

/** An event without a call to the API: a message refused by the budget, for example. */
export function logEvent(event: string, details: Details = {}, path?: string): Record<string, unknown> {
  return write(add({ date: now(), event }, details), path);
}
