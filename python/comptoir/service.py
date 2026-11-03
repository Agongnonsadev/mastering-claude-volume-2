"""The shipped Comptoir, behind its channels (chapter 19): the web chat and WhatsApp.

Until now, the web chat of chapter 6 talked to an assistant without tools, and the routed Comptoir only
lived in the test harnesses, a conversation in memory. Online, each message:
1. finds its conversation in the database (comptoir/conversations.py), or opens one;
2. reserves its cost in the budget, for the whole message;
3. goes through the routed Comptoir (chapter 12), with its tools, its confirmation by code and its guards;
4. adds to the conversation what the turn produced, without rewriting anything, then settles the real cost;
5. leaves in the log a “message” event: channel, category, cost of all the steps, duration.
   That is what the dashboard reads: the cost per conversation, the latency per message.

Why the budget at the level of the message: since the router, the routing, the document assistant and
the complaints chain call Claude without going through comptoir/call.py; the budget of chapter 8
saw only the calls of the Comptoir itself. So the service reserves a ceiling per message, with the
customer's quota and that of their group (their address on the web, their number on WhatsApp), then settles
what the trace really cost, all steps included.

One message at a time for the whole Comptoir (a single thread of execution, on the web server's side): the
SQLite databases are shared, and one transaction must not cross another. At 40 conversations a
day, waiting is rare; beyond that, a connection per thread or a database such as PostgreSQL.
"""

import json
import threading
import time
from dataclasses import dataclass

import anthropic

from comptoir import config
from comptoir.budget import Budget
from comptoir.errors import UNAVAILABLE, ComptoirError, diagnose
from comptoir.log import log_event
from comptoir.prompt import load
from comptoir.routing import RoutedComptoir

# The ceiling reserved for a message, before its cost is known: generous compared with the measured costs
# ($0.0009 per message on average on the shipped Comptoir, in chapter 17; a complaint, drafted by
# Claude Sonnet 5.5, a few thousandths of a dollar).
MESSAGE_RESERVE = 0.02
BASE_TOKENS = 7000  # Awa's base, attached to each request (about 6,900 tokens, chapter 17)


@dataclass
class Turn:
    text: str
    conversation: str
    category: str
    cost_dollars: float = 0.0
    duration_ms: int = 0
    error: str | None = None


def estimate_tokens(history: list[dict]) -> int:
    """The size of the context, roughly: about 3 characters per token in French, plus the base.
    It is only used to close a conversation that is too long (config.MAX_CONTEXT)."""
    return len(json.dumps(history, ensure_ascii=False)) // 3 + BASE_TOKENS


class ComptoirService:
    def __init__(self, client, shop, budget: Budget, conversations, knowledge, **options):
        """options: those of RoutedComptoir (prompt_version, comptoir_effort, cache…), for a variant."""
        self.client, self.shop, self.budget, self.conversations, self.knowledge = client, shop, budget, conversations, knowledge
        self.options = options
        self.prompt = load(options.get("prompt_version", "v5")).id
        self._lock = threading.Lock()

    def open(self, conversation: str | None) -> tuple[str, str | None, bool]:
        """(the conversation to use, the reason if the old one was closed, True if it is new)."""
        reason = None
        if conversation and self.conversations.exists(conversation):
            reason = self.conversations.closing_reason(conversation, self.prompt)
            if reason is None:
                return conversation, None, False
        elif conversation:
            reason = "unknown"
        return self.conversations.create(self.prompt), reason, True

    def answer(self, conversation: str, text: str, channel: str, group: str | None = None) -> Turn:
        with self._lock:
            return self._answer(conversation, text, channel, group)

    def _answer(self, conversation: str, text: str, channel: str, group: str | None) -> Turn:
        decision = self.budget.reserve(conversation, MESSAGE_RESERVE, group=group)
        if not decision.accepted:
            log_event("over_budget", reason=decision.reason, customer=conversation, channel=channel)
            return Turn(UNAVAILABLE, conversation, "over_budget", error=decision.reason)
        history = self.conversations.history(conversation)
        # The budget of each call is kept here, at the level of the message: the Comptoir receives a blank
        # budget, which refuses nothing and counts nothing twice.
        comptoir = RoutedComptoir(self.client, self.shop, Budget(":memory:"), conversation, self.knowledge,
                                  **self.options)
        comptoir.comptoir.history = list(history)
        start = time.perf_counter()
        try:
            answer = comptoir.answer(text)
        except (ComptoirError, anthropic.APIError) as error:
            # The router, the document assistant and the complaints call Claude outside comptoir/call.py
            # (chapter 12): their errors arrive raw. So the diagnosis of chapter 8 is made here too.
            diagnostic = error.diagnostic if isinstance(error, ComptoirError) else diagnose(error)
            duration = round((time.perf_counter() - start) * 1000)
            # The cost of a failure is not known to the code: the reservation stays, the Console is authoritative.
            log_event("message", channel=channel, conversation=conversation, error=diagnostic.code,
                      origin=diagnostic.origin, duration_ms=duration)
            return Turn(diagnostic.for_customer, conversation, "error", duration_ms=duration, error=diagnostic.code)
        new = comptoir.comptoir.history[len(history):]
        if new:
            self.conversations.add_turn(conversation, new, estimate_tokens(comptoir.comptoir.history))
        cost = answer.trace.cost   # all the steps, from the trace of chapter 12
        self.budget.settle(decision.reservation, cost)
        log_event("message", channel=channel, conversation=conversation, category=answer.category,
                  cost_dollars=round(cost, 6), duration_ms=answer.trace.duration_ms,
                  steps=len(answer.trace.steps))
        return Turn(answer.text, conversation, answer.category, cost, answer.trace.duration_ms)
