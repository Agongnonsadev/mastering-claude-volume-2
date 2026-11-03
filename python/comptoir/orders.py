"""The Comptoir that takes orders: tools, official summary, confirmation by the customer (chapter 9).

The approval pattern is simple and does not depend on the model:
1. Claude prepares a summary with the order_prepare tool;
2. the code itself shows the official summary, with the total and a four-digit code;
3. the customer replies “YES 1234”; this message is read by the code, not by Claude;
4. the code creates the order, only once.
"""

import re
from dataclasses import dataclass

from comptoir import assistant
from comptoir.budget import Budget
from comptoir.guard import announces_pass_on
from comptoir.knowledge import Chunk, result_blocks
from comptoir.log import log_event
from comptoir.loop import Turn, converse
from comptoir.prompt import customer_message, load
from comptoir.shop import Shop, ShopRefusal
from comptoir.tools import TOOLS, Tools

PROMPT_VERSION = "v2"
CONFIRMATION = re.compile(r"^\s*yes\s+(\d{4})\s*[.!]?\s*$", re.IGNORECASE)


def render_summary(summary: dict) -> str:
    """The summary the customer sees: written by the code, from the shop's data."""
    lines = [f"  {l['quantity']} × {l['product']}: {l['amount']:,} FCFA" for l in summary["lines"]]
    fee = summary["delivery_fee"]
    return "\n".join(
        ["Your order summary", *lines,
         f"  Delivery ({summary['neighborhood']}, {summary['planned_delivery']}): "
         + ("free" if fee == 0 else f"{fee} FCFA"),
         f"  Total: {summary['total_fcfa']:,} FCFA",
         f"To confirm, reply exactly: YES {summary['confirmation_code']}"]
    )


@dataclass
class Answer:
    text: str                   # what the customer reads
    new_messages: list[dict]
    turn: Turn | None = None    # None: the answer comes from the code (confirmation)


class ComptoirOrders:
    """A conversation with the Comptoir, tools included. The history is append-only."""

    def __init__(self, client, shop: Shop, budget: Budget, conversation: str,
                 prompt_version: str = PROMPT_VERSION, knowledge: list[Chunk] | None = None,
                 cache: bool | str = False, model: str | None = None, effort: str | None = None):
        """Chapter 11: prompt_version="v3", Awa's base as knowledge, and the cache.

        cache="1h": the beginning common to all customers (tools, prompt, base) is kept one hour;
        the end of each conversation stays in the automatic 5-minute cache.
        model (chapter 17): None for the model of config; another one, to evaluate it.
        effort (chapter 19): the effort of that model, constant for the whole conversation (changing it
        would invalidate the cache); None for the model's default.
        """
        self.client, self.shop, self.budget, self.conversation = client, shop, budget, conversation
        self.model, self.effort = model, effort
        self.prompt = load(prompt_version)
        self.cache = bool(cache)
        # The blocks are built once and for all: identical from one turn to the next.
        self.blocks = result_blocks(knowledge, cache=cache) if knowledge else None
        self.history: list[dict] = []

    def request(self, text: str) -> dict:
        request = assistant.build_request(text, history=self.history, prompt=self.prompt,
                                          cache=self.cache, knowledge=self.blocks, model=self.model,
                                          effort=self.effort)
        # The tools do not change during a conversation: modifying them would invalidate the preserved
        # thinking of all the previous turns (chapter 6).
        request["tools"] = TOOLS
        return request

    def answer(self, text: str) -> Answer:
        confirmation = CONFIRMATION.match(text)
        if confirmation:
            answer = self._confirm(text, confirmation.group(1))
        else:
            turn = converse(self.client, self.request(text), Tools(self.shop, self.conversation),
                            self.budget, self.conversation, self.prompt.id)
            if turn.stop and turn.stop.code == "refusal":
                # As in chapter 8: the refused answer is thrown away, and the turn does not enter the history.
                return Answer(turn.stop.for_customer, [], turn)
            visible = turn.text
            if announces_pass_on(turn.text) and not turn.execution.passed_on:
                # Chapter 18: the customer read “I'm passing your request on to Awa”; the code keeps the promise
                # the model made without calling the tool. Awa receives the customer's message, as is.
                request = self.shop.pass_on(self.conversation, "other",
                                            f"Pass-on announced to the customer by the Comptoir. Their message: "
                                            f"{text[:300]}")
                turn.execution.passed_on.append(request)
                log_event("guard", rule="announced_pass_on", request=request["request"])
            if turn.execution.summary:
                visible = f"{visible}\n\n{render_summary(turn.execution.summary)}"
            question = {"role": "user", "content": customer_message(text)}
            answer = Answer(visible, [question, *turn.new_messages], turn)
        self.history.extend(answer.new_messages)
        return answer

    def _confirm(self, text: str, code: str) -> Answer:
        """The confirmation does not go through Claude: the code reads the message and creates the order."""
        try:
            order = self.shop.confirm(self.conversation, code)
            visible = (f"Your order {order['order']} is recorded, for a total of "
                       f"{order['total_fcfa']:,} FCFA. Awa will contact you about delivery. Thank you!")
            if order["already_recorded"]:
                visible = f"Your order {order['order']} was already recorded: nothing has been added."
        except ShopRefusal as refusal:
            visible = f"I could not confirm: {refusal}"
        # The exchange enters the history, so that Claude knows, at the next turn, what happened.
        exchange = [{"role": "user", "content": customer_message(text)},
                    {"role": "assistant", "content": [{"type": "text", "text": visible}]}]
        return Answer(visible, exchange)
