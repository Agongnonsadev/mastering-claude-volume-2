"""Recognize each error, and know what to do about it (chapter 8).

Two questions for each failure:
- should we retry? Yes if the same request can succeed later (overload, cut,
  rate limit); no if something must be fixed (key, request, budget);
- where does it come from? The network, Anthropic's service, our code (the integration),
  our account, or the model's answer. That is what says who must act.

The error classes are those of the anthropic SDK, checked in its version 1.15.0.
"""

from dataclasses import dataclass

import anthropic
import httpx2

# What Awa's customer sees: never a technical detail, always polite.
TEMPORARY = "The Comptoir is very busy right now. Try again in a moment."
UNAVAILABLE = "The Comptoir can't answer right now. Awa will reply to you directly, as soon as possible."
REFUSAL = "I can't answer this request. Awa will reply to you directly, as soon as possible."
CUT_SHORT = "My answer was cut short. Could you ask your question more briefly?"


@dataclass(frozen=True)
class Diagnostic:
    code: str               # short and stable, for the log and the dashboard
    retry: bool             # can the same request, later, succeed?
    origin: str             # network, service, integration, account, model
    for_customer: str
    for_yao: str            # what must be done
    wait_s: float | None = None  # what the retry-after header asks for


class ComptoirError(Exception):
    def __init__(self, diagnostic: Diagnostic):
        super().__init__(f"{diagnostic.code}: {diagnostic.for_yao}")
        self.diagnostic = diagnostic


def _body(error: anthropic.APIStatusError) -> dict:
    return error.body if isinstance(error.body, dict) else {}


def _wait(error: anthropic.APIStatusError) -> float | None:
    value = error.response.headers.get("retry-after")
    try:
        return float(value) if value is not None else None
    except ValueError:
        return None


def diagnose(error: BaseException) -> Diagnostic:
    """The diagnosis of an exception raised by a call to the API."""
    if isinstance(error, anthropic.APIStatusError):
        body = _body(error).get("error", {})
        message = body.get("message", "")
        detail_code = (body.get("details") or {}).get("error_code")
        status = error.status_code

        if isinstance(error, anthropic.AuthenticationError):  # 401
            return Diagnostic("invalid_key", False, "account", UNAVAILABLE,
                              "Key refused: badly copied, revoked or expired. Create another one in the Console.")
        if status == 402:
            return Diagnostic("billing", False, "account", UNAVAILABLE,
                              "Billing problem: check the credits and the payment method in the Console.")
        if isinstance(error, anthropic.PermissionDeniedError):  # 403
            return Diagnostic("permission", False, "account", UNAVAILABLE,
                              "The key has no access to this resource: check its workspace.")
        if isinstance(error, anthropic.NotFoundError):  # 404
            return Diagnostic("not_found", False, "integration", UNAVAILABLE,
                              "Model or resource not found: check COMPTOIR_MODEL (model retired?).")
        if isinstance(error, anthropic.RequestTooLargeError):  # 413
            return Diagnostic("request_too_large", False, "integration", UNAVAILABLE,
                              "Request beyond the allowed size (32 MB): shrink the images, or use the Files API.")
        if isinstance(error, anthropic.RateLimitError):  # 429
            if detail_code == "enforced_spend_limit_reached":
                # Same error type as a rate limit, but without retry-after: retrying
                # is pointless before the next month.
                return Diagnostic("tier_ceiling", False, "account", UNAVAILABLE,
                                  "Tier's monthly ceiling reached: request a higher tier in the Console.")
            return Diagnostic("rate_limit", True, "account", TEMPORARY,
                              "Rate limit reached: spread out the calls, or request higher limits.",
                              _wait(error))
        if isinstance(error, anthropic.BadRequestError):  # 400
            if "usage limits" in message:
                return Diagnostic("spend_limit", False, "account", UNAVAILABLE,
                                  "Your spend limit is reached: raise it in the Console, "
                                  "or wait for the date given in the message.")
            return Diagnostic("invalid_request", False, "integration", UNAVAILABLE,
                              f"Request refused by the API: fix the code. Message: {message[:200]}")
        if isinstance(error, anthropic.ConflictError):  # 409
            return Diagnostic("conflict", True, "service", TEMPORARY, "Transient conflict: the SDK retries.")
        if isinstance(error, anthropic.OverloadedError) or body.get("type") == "overloaded_error":  # 529
            return Diagnostic("overloaded", True, "service", TEMPORARY,
                              "Service overloaded: automatic retry; if it lasts, see the status page.")
        if status == 504 or body.get("type") == "timeout_error":
            return Diagnostic("api_timeout", True, "service", TEMPORARY,
                              "The API took too long: prefer streaming for long answers.")
        if status >= 500 or body.get("type") == "api_error":
            return Diagnostic("internal_error", True, "service", TEMPORARY,
                              "Anthropic internal error: retry; if it persists, support with the request ID.")
        return Diagnostic("api_error", False, "integration", UNAVAILABLE, f"Error {status}: {message[:200]}")

    if type(error).__name__ == "IncompleteStream":  # comptoir.streaming, chapter 6
        return Diagnostic("incomplete_stream", True, "network", TEMPORARY,
                          "Stream closed without message_stop: truncated answer, automatic resumption.")
    if isinstance(error, anthropic.APITimeoutError):  # before APIConnectionError, which it inherits from
        return Diagnostic("timeout", True, "network", TEMPORARY,
                          "No answer within the timeout: slow network, or timeout too short (COMPTOIR_TIMEOUT_S).")
    if isinstance(error, (anthropic.APIConnectionError, httpx2.TransportError)):
        return Diagnostic("connection", True, "network", TEMPORARY, "Connection to the API impossible or cut.")
    return Diagnostic("unknown", False, "integration", UNAVAILABLE,
                      f"Unexpected error in the code: {type(error).__name__}. Read the full trace.")


def diagnose_stop(message) -> Diagnostic | None:
    """The diagnosis of an answer that arrived, but did not stop normally."""
    reason = message.stop_reason
    if reason == "refusal":
        details = getattr(message, "stop_details", None)
        category = getattr(details, "category", None) or "not specified"
        return Diagnostic("refusal", False, "model", REFUSAL,
                          f"Refusal by the safety classifiers (category: {category}). Read the conversation; "
                          "if the request was legitimate, another model can answer it (fallback).")
    if reason == "max_tokens":
        return Diagnostic("cut_off_answer", False, "integration", CUT_SHORT,
                          "Answer cut by max_tokens: raise the ceiling, or ask for shorter answers.")
    if reason == "model_context_window_exceeded":
        return Diagnostic("context_full", False, "integration", UNAVAILABLE,
                          "The context window is full: reduce the history (chapter 6).")
    if reason == "pause_turn":
        return Diagnostic("pause", True, "model", TEMPORARY,
                          "Server tool loop paused: send the answer back as is to continue (chapter 10).")
    return None
