"""Each error gets the right diagnosis: retry or fix, and where it comes from."""

from types import SimpleNamespace

import anthropic
import httpx2
import pytest

from comptoir.errors import REFUSAL, TEMPORARY, UNAVAILABLE, diagnose, diagnose_stop

REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


def api_error(cls, status, error_type, message="", details=None, headers=None):
    body = {"type": "error", "error": {"type": error_type, "message": message}}
    if details:
        body["error"]["details"] = details
    response = httpx2.Response(status, json=body, headers=headers or {}, request=REQUEST)
    return cls(message, response=response, body=body)


@pytest.mark.parametrize(
    "error, code, retry, origin",
    [
        (api_error(anthropic.AuthenticationError, 401, "authentication_error"), "invalid_key", False, "account"),
        (api_error(anthropic.APIStatusError, 402, "billing_error"), "billing", False, "account"),
        (api_error(anthropic.PermissionDeniedError, 403, "permission_error"), "permission", False, "account"),
        (api_error(anthropic.NotFoundError, 404, "not_found_error"), "not_found", False, "integration"),
        (api_error(anthropic.RequestTooLargeError, 413, "request_too_large"), "request_too_large", False, "integration"),
        (api_error(anthropic.BadRequestError, 400, "invalid_request_error", "messages.0: bad"), "invalid_request", False, "integration"),
        (api_error(anthropic.OverloadedError, 529, "overloaded_error"), "overloaded", True, "service"),
        (api_error(anthropic.InternalServerError, 500, "api_error"), "internal_error", True, "service"),
        (api_error(anthropic.InternalServerError, 504, "timeout_error"), "api_timeout", True, "service"),
        (anthropic.APITimeoutError(request=REQUEST), "timeout", True, "network"),
        (anthropic.APIConnectionError(request=REQUEST), "connection", True, "network"),
        (httpx2.RemoteProtocolError("cut"), "connection", True, "network"),
        (KeyError("bug"), "unknown", False, "integration"),
    ],
)
def test_each_error_has_its_diagnosis(error, code, retry, origin):
    diagnostic = diagnose(error)
    assert (diagnostic.code, diagnostic.retry, diagnostic.origin) == (code, retry, origin)
    assert diagnostic.for_customer in (TEMPORARY, UNAVAILABLE)


def test_a_rate_limit_is_retried_after_the_requested_delay():
    error = api_error(anthropic.RateLimitError, 429, "rate_limit_error", headers={"retry-after": "12"})
    diagnostic = diagnose(error)
    assert diagnostic.code == "rate_limit" and diagnostic.retry and diagnostic.wait_s == 12


def test_the_tier_ceiling_is_not_retried():
    # Same status and same type as a rate limit, but a code that changes everything.
    error = api_error(anthropic.RateLimitError, 429, "rate_limit_error",
                      "You have reached your API usage limits: ...", {"error_code": "enforced_spend_limit_reached"})
    diagnostic = diagnose(error)
    assert diagnostic.code == "tier_ceiling" and not diagnostic.retry


def test_the_spend_limit_you_set():
    error = api_error(anthropic.BadRequestError, 400, "invalid_request_error",
                      "You have reached your specified API usage limits. You will regain access on 2026-11-01.")
    assert diagnose(error).code == "spend_limit"


def test_an_error_mid_stream_keeps_the_200_status():
    error = api_error(anthropic.APIStatusError, 200, "overloaded_error", "Overloaded")
    assert diagnose(error).code == "overloaded"


def test_the_stop_reasons():
    refusal = SimpleNamespace(stop_reason="refusal", stop_details=SimpleNamespace(category="cyber"))
    diagnostic = diagnose_stop(refusal)
    assert diagnostic.code == "refusal" and "cyber" in diagnostic.for_yao and diagnostic.for_customer == REFUSAL
    assert diagnose_stop(SimpleNamespace(stop_reason="max_tokens")).code == "cut_off_answer"
    assert diagnose_stop(SimpleNamespace(stop_reason="model_context_window_exceeded")).code == "context_full"
    assert diagnose_stop(SimpleNamespace(stop_reason="end_turn")) is None
