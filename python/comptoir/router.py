"""The Comptoir's router: one message, one category, one service (chapter 12).

The code first decides what it knows: a confirmation “YES 1234”, an order in progress.
The model classifies the rest, with a structured output that can take only four values.
It sees only the message: neither the tools, nor the base, nor the history. A booby-trapped
message can therefore make it do nothing other than choose a category.
"""

import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from comptoir import config
from comptoir.costs import cost
from comptoir.log import log_call
from comptoir.orders import CONFIRMATION
from comptoir.prompt import customer_message

CATEGORIES = ("complaint", "order", "information", "other")  # by order of priority
ROUTER_MODEL = config.ROUTER_MODEL
PROMPT = (Path(__file__).parent / "prompts" / "router_v1.md").read_text(encoding="utf-8").strip()

SCHEMA = {
    "type": "object",
    "properties": {
        "category": {"type": "string", "enum": list(CATEGORIES)},
        "reason": {"type": "string"},
    },
    "required": ["category", "reason"],
    "additionalProperties": False,
}


class RoutingImpossible(Exception):
    """A cut-off or unreadable answer: the message goes to the Comptoir, which can handle everything."""


@dataclass(frozen=True)
class Decision:
    category: str
    reason: str
    by: str           # “code” or the model's name
    cost: float = 0.0


def routing_request(message: str, model: str = ROUTER_MODEL, effort: str | None = None,
                    no_thinking: bool = False) -> dict:
    output_config = {"format": {"type": "json_schema", "schema": SCHEMA}}
    if effort:
        output_config["effort"] = effort
    request = {
        "model": model,
        # Enough room for the thinking and the JSON: too low a ceiling cuts the answer off.
        "max_tokens": 1000,
        "system": PROMPT,
        "messages": [{"role": "user", "content": customer_message(message)}],
        "output_config": output_config,
    }
    if no_thinking:
        request["thinking"] = {"type": "disabled"}  # accepted by Claude Haiku 5.5 (chapter 3)
    return request


def classify(client, message: str, model: str = ROUTER_MODEL, effort: str | None = None,
             no_thinking: bool = False) -> Decision:
    """One call to the model. The category is validated by the code: outside the four, it is an error."""
    request = routing_request(message, model, effort, no_thinking)
    response = client.messages.create(**request)
    price = cost(model, response.usage)
    log_call(response._request_id, model, price, prompt="router-v1", stop_reason=response.stop_reason)
    if response.stop_reason != "end_turn":
        raise RoutingImpossible(f"answer stopped by {response.stop_reason}")
    try:
        data = json.loads("".join(b.text for b in response.content if b.type == "text"))
    except json.JSONDecodeError as error:
        raise RoutingImpossible("unreadable answer") from error
    # The case of an enum value is not guaranteed: “Information” is an information.
    category = str(data.get("category", "")).lower()
    if category not in CATEGORIES:
        raise RoutingImpossible(f"unknown category: {data.get('category')!r}")
    return Decision(category, data["reason"], model, price.dollars)


def by_code(message: str) -> Decision | None:
    """What the code knows without asking: the confirmation of a summary."""
    if CONFIRMATION.match(message):
        return Decision("order", "confirmation of a summary", "code")
    return None


def route(client, message: str, order_in_progress: bool = False, **options) -> Decision:
    try:
        decision = by_code(message) or classify(client, message, **options)
    except RoutingImpossible as error:
        # The most general service: the Comptoir, whose rules pass complaints on to Awa.
        return Decision("other", f"classification impossible ({error})", "fallback")
    # During an order, what follows goes to the Comptoir, which has the history and the tools.
    # A complaint stays a complaint.
    if order_in_progress and decision.category in ("information", "other"):
        return Decision("order", f"order in progress ({decision.category})", decision.by, decision.cost)
    return decision


def vote(decisions: list[Decision]) -> str:
    """The most voted category; in case of a tie, the highest priority: when in doubt, a complaint
    goes to Awa rather than getting lost."""
    count = Counter(d.category for d in decisions)
    best = max(count.values())
    return next(c for c in CATEGORIES if count.get(c) == best)


def route_by_vote(client, message: str, votes: int = 3, **options) -> tuple[str, list[Decision]]:
    """The same classification, several times in parallel (parallelization by voting)."""
    with ThreadPoolExecutor(max_workers=votes) as executor:
        decisions = list(executor.map(lambda _: classify(client, message, **options), range(votes)))
    return vote(decisions), decisions
