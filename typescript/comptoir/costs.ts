// Convert the consumption of a call (the usage field) into dollars (chapter 2).
//
// Prices read on platform.claude.com on October 19, 2026, rechecked on October 22, 2026 (Appendix D),
// in dollars per million tokens: the same as python/comptoir/costs.py.
// Check them before using them: they change (Appendix D, companion page).

export interface Rate {
  input: number; //        input tokens outside the cache
  write5m: number; //      writing to the 5-minute cache
  write1h: number; //      writing to the one-hour cache
  cacheRead: number; //    reading from the cache
  output: number; //       output tokens, thinking included
}

const rate = (input: number, write5m: number, write1h: number, cacheRead: number, output: number): Rate =>
  ({ input, write5m, write1h, cacheRead, output });

export const RATES: Record<string, Rate> = {
  "claude-fable-5-1": rate(10.0, 12.5, 20.0, 0.25, 50.0),
  "claude-opus-5-5": rate(4.0, 5.0, 8.0, 0.2, 20.0),
  "claude-sonnet-5-5": rate(2.0, 2.5, 4.0, 0.1, 10.0),
  "claude-haiku-5-5": rate(0.1, 0.125, 0.2, 0.01, 0.5),
};

// Claude Haiku 5.5 costs more when the prompt goes beyond 100,000 tokens.
export const LONG_PROMPT_THRESHOLD = 100_000;
export const LONG_PROMPT_RATES: Record<string, Rate> = {
  "claude-haiku-5-5": rate(0.5, 0.625, 1.0, 0.05, 2.5),
};

// Batch API (batch processing): 50% discount on input and output, and the cache multipliers stack with this
// discount, so every item is halved. Source: Anthropic's Pricing page, reread on October 20, 2026.
export const BATCH_DISCOUNT = 0.5;

// Web search: $10 per 1,000 searches, on top of the tokens (Pricing, October 20, 2026). Same price
// through the Batch API. Fetching pages costs only its tokens (chapter 10).
export const WEB_SEARCH_PRICE = 10.0 / 1000;

/**
 * The usage of a call, as the SDK gives it or as it is read back from a JSON (log, results of a
 * batch). A missing or null field counts zero.
 */
export interface ReadUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
  output_tokens_details?: { thinking_tokens?: number | null } | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

export class Cost {
  constructor(
    readonly dollars: number,
    readonly input: number,
    readonly cacheWrite: number,
    readonly cacheRead: number,
    readonly output: number,
    readonly thinking: number,
    readonly searches = 0, // web searches, billed separately (chapter 10)
  ) {}

  toString(): string {
    return `$${this.dollars.toFixed(4)}`;
  }
}

function rateOf(model: string, promptLength: number): Rate {
  const normal = RATES[model];
  if (!normal) throw new Error(`Unknown price for the model '${model}': add it to RATES.`);
  return (promptLength > LONG_PROMPT_THRESHOLD && LONG_PROMPT_RATES[model]) || normal;
}

/**
 * The highest possible cost of a call, in dollars, before running it (chapter 8).
 *
 * The input is known (countTokens, free); the output will not exceed maxTokens, thinking included.
 * cacheWrite ("5m" or "1h", chapter 11): if the request sets a cache breakpoint, the worst case is an
 * input entirely written to the cache, which costs 1.25 or 2 times the input price.
 */
export function maxCost(model: string, inputTokens: number, maxTokens: number, cacheWrite: "5m" | "1h" | null = null): number {
  const r = rateOf(model, inputTokens);
  const inputPrice = cacheWrite === "5m" ? r.write5m : cacheWrite === "1h" ? r.write1h : r.input;
  return (inputTokens * inputPrice + maxTokens * r.output) / 1_000_000;
}

/**
 * The most expensive cache duration a request asks for: "1h", "5m", or null without a cache breakpoint.
 * The breakpoints can be anywhere: at the top, on a tool, a block, a message.
 */
export function cacheDuration(request: unknown): "1h" | "5m" | null {
  const durations = new Set<string>();
  const walk = (obj: unknown): void => {
    if (Array.isArray(obj)) {
      obj.forEach(walk);
    } else if (obj !== null && typeof obj === "object") {
      const control = (obj as { cache_control?: unknown }).cache_control;
      if (control !== null && typeof control === "object") durations.add((control as { ttl?: string }).ttl ?? "5m");
      Object.values(obj).forEach(walk);
    }
  };
  walk(request);
  return durations.has("1h") ? "1h" : durations.size ? "5m" : null;
}

/**
 * Calculates the cost of a call from its usage field.
 *
 * batch=true for a call made through the Batch API. usage.service_tier may be “batch”, but the
 * discount is still requested explicitly by the caller.
 */
export function cost(model: string, usage: ReadUsage | null | undefined, batch = false): Cost {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const read = usage?.cache_read_input_tokens ?? 0;
  const write = usage?.cache_creation_input_tokens ?? 0;
  const write1h = usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = write - write1h; // without detail, everything is counted as 5 minutes
  const thinking = usage?.output_tokens_details?.thinking_tokens ?? 0;
  const searches = usage?.server_tool_use?.web_search_requests ?? 0;

  // The prompt length counts all input tokens, cache included.
  const r = rateOf(model, input + read + write);
  let dollars =
    (input * r.input +
      write5m * r.write5m +
      write1h * r.write1h +
      read * r.cacheRead +
      output * r.output) / // output_tokens already includes thinking
    1_000_000;
  if (batch) dollars *= BATCH_DISCOUNT; // after choosing the rate: the threshold applies to the raw tokens
  dollars += searches * WEB_SEARCH_PRICE; // no batch discount

  return new Cost(dollars, input, write, read, output, thinking, searches);
}
