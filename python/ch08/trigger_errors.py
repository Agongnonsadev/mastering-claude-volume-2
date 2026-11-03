"""Chapter 8: trigger each error on purpose, and read the Comptoir's diagnosis.

Run, from the python/ folder:
    python -m ch08.trigger_errors              (all cases)
    python -m ch08.trigger_errors key budget   (some cases)

Cost: almost nothing. The errors returned by the API (key, model, invalid request) are not
billed; the max_tokens case makes a call of a few tokens; the budget case only does a
count, which is free.
"""

import sys

import anthropic

from comptoir import assistant, config
from comptoir.budget import Budget
from comptoir.call import call_claude
from comptoir.errors import ComptoirError, diagnose, diagnose_stop

QUESTION = [{"role": "user", "content": "Hello"}]


def show(name: str, diagnostic) -> None:
    if diagnostic is None:
        print(f"{name:10} no anomaly")
        return
    print(f"{name:10} {diagnostic.code} (origin: {diagnostic.origin}, retry: {'yes' if diagnostic.retry else 'no'})")
    print(f"{'':10} customer: {diagnostic.for_customer}")
    print(f"{'':10} Yao:      {diagnostic.for_yao}")


def attempt(name: str, client, **request) -> None:
    request = {"model": config.MODEL, "max_tokens": 50, "messages": QUESTION, **request}
    try:
        message = client.messages.create(**request)
    except Exception as error:
        show(name, diagnose(error))
        return
    show(name, diagnose_stop(message))


def budget_case() -> None:
    """A tiny customer quota: the call is refused before it goes out."""
    config.CUSTOMER_DAILY_QUOTA = 0.000001
    try:
        call_claude(anthropic.Anthropic(), assistant.build_request("Hello"), Budget(), "budget-trial")
    except ComptoirError as error:
        show("budget", error.diagnostic)


CASES = {
    # A wrong key, written in plain text on purpose: it gives access to nothing.
    "key": lambda: attempt("key", anthropic.Anthropic(api_key="sk-ant-deliberately-fake-key", max_retries=0)),
    "model": lambda: attempt("model", anthropic.Anthropic(max_retries=0), model="claude-nonexistent-model"),
    "prefill": lambda: attempt(
        "prefill", anthropic.Anthropic(max_retries=0),
        messages=QUESTION + [{"role": "assistant", "content": "Hello, I"}],
    ),
    "timeout": lambda: attempt("timeout", anthropic.Anthropic(timeout=0.001, max_retries=0)),
    "max_tokens": lambda: attempt("max_tokens", anthropic.Anthropic(), max_tokens=5),
    "budget": budget_case,
}


if __name__ == "__main__":
    for name in sys.argv[1:] or CASES:
        CASES[name]()
