"""A call to Claude that withstands failures and respects the budget (chapter 8).

In order: count the input (free), reserve the maximum cost, call, record in the
log what happened, settle the real cost, and translate any failure into a diagnosis.
"""

import time
from dataclasses import dataclass

import anthropic

from comptoir import config
from comptoir.budget import Budget
from comptoir.costs import Cost, cache_duration, cost, max_cost
from comptoir.errors import UNAVAILABLE, ComptoirError, Diagnostic, diagnose, diagnose_stop
from comptoir.log import log_call, log_event

# The request parameters that the counting tool accepts too.
COUNTING_FIELDS = ("model", "messages", "system", "tools", "tool_choice", "thinking", "output_config")


class OverBudget(ComptoirError):
    pass


def make_client() -> anthropic.Anthropic:
    """The Comptoir's client: timeout and retries set, rather than the SDK's defaults."""
    return anthropic.Anthropic(timeout=config.TIMEOUT_S, max_retries=config.RETRIES)


def estimate_maximum(client, request: dict) -> float:
    count = client.messages.count_tokens(**{k: v for k, v in request.items() if k in COUNTING_FIELDS})
    # With a cache breakpoint, the input may be written to the cache: dearer than the input (chapter 11).
    return max_cost(request["model"], count.input_tokens, request["max_tokens"], cache_duration(request))


@dataclass
class Reply:
    message: object
    text: str
    cost: Cost
    stop: Diagnostic | None  # None: the answer stopped normally
    alert: bool              # the daily or monthly budget is approaching its ceiling


def call_claude(client, request: dict, budget: Budget, customer_id: str, prompt: str | None = None) -> Reply:
    try:
        maximum = estimate_maximum(client, request)
    except Exception as error:  # counting fails as the call would fail: same diagnosis
        diagnostic = diagnose(error)
        log_event("counting_impossible", customer=customer_id, error=diagnostic.code, origin=diagnostic.origin)
        raise ComptoirError(diagnostic) from error
    decision = budget.reserve(customer_id, maximum)
    if not decision.accepted:
        log_event("over_budget", reason=decision.reason, customer=customer_id)
        raise OverBudget(Diagnostic(decision.reason, False, "account", UNAVAILABLE,
                                    f"Call refused by the Comptoir's budget ({decision.reason})."))

    start = time.monotonic()
    try:
        message = client.messages.create(**request)
    except Exception as error:
        diagnostic = diagnose(error)
        request_id = getattr(error, "request_id", None)
        log_call(request_id, request["model"], None, prompt=prompt, customer=customer_id, error=diagnostic.code,
                 origin=diagnostic.origin, duration_ms=round((time.monotonic() - start) * 1000))
        # An error returned by the API is not billed; a network cut can be
        # (the request may have gone through without the answer arriving): the reserve is then kept.
        if isinstance(error, anthropic.APIStatusError):
            budget.release(decision.reservation)
        raise ComptoirError(diagnostic) from error

    price = cost(request["model"], message.usage)
    budget.settle(decision.reservation, price.dollars)
    stop = diagnose_stop(message)
    log_call(message._request_id, request["model"], price, prompt=prompt, customer=customer_id,
             stop_reason=message.stop_reason, duration_ms=round((time.monotonic() - start) * 1000),
             error=stop.code if stop else None, origin=stop.origin if stop else None)
    text = "".join(b.text for b in message.content if b.type == "text")
    return Reply(message, text, price, stop, budget.on_alert())
