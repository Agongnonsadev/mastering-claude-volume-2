// Recognize each error, and know what to do about it (chapter 8).
//
// Two questions for each failure:
// - should we retry? Yes if the same request can succeed later (overload, cut, rate limit); no if
//   something must be fixed (key, request, budget);
// - where does it come from? The network, Anthropic's service, our code (the integration), our account,
//   or the model's answer. That is what says who must act.
//
// The error classes are those of the @anthropic-ai/sdk 1.x SDK, checked in its version 1.1.0. It has no
// class for 402, 413 or 529: the status is read instead, or the error type of the body.

import Anthropic from "@anthropic-ai/sdk";

// What Awa's customer sees: never a technical detail, always polite.
export const TEMPORARY = "The Comptoir is very busy right now. Try again in a moment.";
export const UNAVAILABLE = "The Comptoir can't answer right now. Awa will reply to you directly, as soon as possible.";
export const REFUSAL = "I can't answer this request. Awa will reply to you directly, as soon as possible.";
export const CUT_SHORT = "My answer was cut short. Could you ask your question more briefly?";

export type Origin = "network" | "service" | "integration" | "account" | "model";

export interface Diagnostic {
  code: string; //            short and stable, for the log and the dashboard
  retry: boolean; //          can the same request, later, succeed?
  origin: Origin;
  forCustomer: string;
  forYao: string; //          what must be done
  waitS: number | null; //    what the retry-after header asks for
}

const diagnostic = (
  code: string,
  retry: boolean,
  origin: Origin,
  forCustomer: string,
  forYao: string,
  waitS: number | null = null,
): Diagnostic => ({ code, retry, origin, forCustomer, forYao, waitS });

export class ComptoirError extends Error {
  constructor(
    readonly diagnostic: Diagnostic,
    options?: { cause?: unknown },
  ) {
    super(`${diagnostic.code}: ${diagnostic.forYao}`, options);
  }
}

/**
 * The stream stopped before message_stop. The TypeScript SDK then raises an AnthropicError without a
 * cause (“stream ended without producing a Message…”); comptoir/streaming.ts turns it into an
 * IncompleteStream (checked by tests/ch06_cutoff.test.ts).
 */
export class IncompleteStream extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Stream closed without message_stop", options);
  }
}

/**
 * A connection that gives way mid-stream: the TypeScript SDK surfaces it as an AnthropicError that is
 * not an API error, without a status, caused by the error of Node's fetch (“terminated”).
 */
export function isCut(error: unknown): boolean {
  return error instanceof Anthropic.AnthropicError && !(error instanceof Anthropic.APIError) && error.cause !== undefined;
}

type ErrorBody = { error?: { type?: string; message?: string; details?: { error_code?: string } | null } };

const body = (error: InstanceType<typeof Anthropic.APIError>): NonNullable<ErrorBody["error"]> =>
  ((error.error ?? {}) as ErrorBody).error ?? {};

function wait(error: InstanceType<typeof Anthropic.APIError>): number | null {
  const value = error.headers?.get("retry-after");
  const n = value === null || value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The diagnosis of an exception raised by a call to the API. */
export function diagnose(error: unknown): Diagnostic {
  // A connection error is also an APIError, without a status: it is handled further down, with the network.
  if (error instanceof Anthropic.APIError && !(error instanceof Anthropic.APIConnectionError)) {
    const b = body(error);
    const message = b.message ?? "";
    const type = b.type ?? error.type;
    const status = error.status;

    if (error instanceof Anthropic.AuthenticationError) {
      return diagnostic("invalid_key", false, "account", UNAVAILABLE,
        "Key refused: badly copied, revoked or expired. Create another one in the Console.");
    }
    if (status === 402) {
      return diagnostic("billing", false, "account", UNAVAILABLE,
        "Billing problem: check the credits and the payment method in the Console.");
    }
    if (error instanceof Anthropic.PermissionDeniedError) {
      return diagnostic("permission", false, "account", UNAVAILABLE,
        "The key has no access to this resource: check its workspace.");
    }
    if (error instanceof Anthropic.NotFoundError) {
      return diagnostic("not_found", false, "integration", UNAVAILABLE,
        "Model or resource not found: check COMPTOIR_MODEL (model retired?).");
    }
    if (status === 413) {
      return diagnostic("request_too_large", false, "integration", UNAVAILABLE,
        "Request beyond the allowed size (32 MB): shrink the images, or use the Files API.");
    }
    if (error instanceof Anthropic.RateLimitError) {
      if (b.details?.error_code === "enforced_spend_limit_reached") {
        // Same error type as a rate limit, but without retry-after: retrying is pointless before the
        // next month.
        return diagnostic("tier_ceiling", false, "account", UNAVAILABLE,
          "Tier's monthly ceiling reached: request a higher tier in the Console.");
      }
      return diagnostic("rate_limit", true, "account", TEMPORARY,
        "Rate limit reached: spread out the calls, or request higher limits.", wait(error));
    }
    if (error instanceof Anthropic.BadRequestError) {
      if (message.includes("usage limits")) {
        return diagnostic("spend_limit", false, "account", UNAVAILABLE,
          "Your spend limit is reached: raise it in the Console, or wait for the date given in the message.");
      }
      return diagnostic("invalid_request", false, "integration", UNAVAILABLE,
        `Request refused by the API: fix the code. Message: ${message.slice(0, 200)}`);
    }
    if (error instanceof Anthropic.ConflictError) {
      return diagnostic("conflict", true, "service", TEMPORARY, "Transient conflict: the SDK retries.");
    }
    // 529, or an error announced mid-stream: without a status, its type is in the body.
    if (status === 529 || type === "overloaded_error") {
      return diagnostic("overloaded", true, "service", TEMPORARY,
        "Service overloaded: automatic retry; if it lasts, see the status page.");
    }
    if (status === 504 || type === "timeout_error") {
      return diagnostic("api_timeout", true, "service", TEMPORARY,
        "The API took too long: prefer streaming for long answers.");
    }
    if ((status ?? 0) >= 500 || type === "api_error") {
      return diagnostic("internal_error", true, "service", TEMPORARY,
        "Anthropic internal error: retry; if it persists, support with the request ID.");
    }
    return diagnostic("api_error", false, "integration", UNAVAILABLE, `Error ${status}: ${message.slice(0, 200)}`);
  }

  if (error instanceof IncompleteStream) {
    return diagnostic("incomplete_stream", true, "network", TEMPORARY,
      "Stream closed without message_stop: truncated answer, automatic resumption.");
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) { // before APIConnectionError, which it inherits from
    return diagnostic("timeout", true, "network", TEMPORARY,
      "No answer within the timeout: slow network, or timeout too short (COMPTOIR_TIMEOUT_S).");
  }
  if (error instanceof Anthropic.APIConnectionError || isCut(error)) {
    return diagnostic("connection", true, "network", TEMPORARY, "Connection to the API impossible or cut.");
  }
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return diagnostic("unknown", false, "integration", UNAVAILABLE,
    `Unexpected error in the code: ${name}. Read the full trace.`);
}

/** The diagnosis of an answer that arrived, but did not stop normally. */
export function diagnoseStop(message: {
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
}): Diagnostic | null {
  switch (message.stop_reason) {
    case "refusal": {
      const category = message.stop_details?.category || "not specified";
      return diagnostic("refusal", false, "model", REFUSAL,
        `Refusal by the safety classifiers (category: ${category}). Read the conversation; ` +
          "if the request was legitimate, another model can answer it (fallback).");
    }
    case "max_tokens":
      return diagnostic("cut_off_answer", false, "integration", CUT_SHORT,
        "Answer cut by max_tokens: raise the ceiling, or ask for shorter answers.");
    case "model_context_window_exceeded":
      return diagnostic("context_full", false, "integration", UNAVAILABLE,
        "The context window is full: reduce the history (chapter 6).");
    case "pause_turn":
      return diagnostic("pause", true, "model", TEMPORARY,
        "Server tool loop paused: send the answer back as is to continue (chapter 10).");
    default:
      return null;
  }
}
