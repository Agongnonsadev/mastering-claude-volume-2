"""The routed Comptoir: one router, three services, one trace per message (chapter 12).

The manager is code, not a model: it asks the router for the category, then entrusts the
message to the right worker, each with its model, its prompt and what it must see, nothing more.
- information: the document assistant, with Claude Haiku 5.5 and Awa's base cached, without
  citations or thinking: with citations, Haiku thinks anyway, and its answers degrade
  (measured in chapter 12); a cut-off answer goes to the Comptoir, as, since
  chapter 18, does an answer that announces a pass-on to Awa (comptoir/guard.py);
- order and other: the Comptoir of chapter 9, with its tools and the base; Claude Sonnet 5.5 in
  chapter 12, Claude Haiku 5.5 since the evaluation of chapter 17 (config.COMPTOIR_MODEL);
- complaint: the complaints chain, which passes everything on to Awa.

The exchanges handled outside the Comptoir are added to its history, in plain text: when the
customer goes on to an order, the Comptoir knows the conversation.
"""

from dataclasses import dataclass

from comptoir import complaints, config, doc_assistant
from comptoir.guard import announces_pass_on
from comptoir.knowledge import Chunk
from comptoir.orders import ComptoirOrders
from comptoir.prompt import customer_message
from comptoir.router import ROUTER_MODEL, route
from comptoir.trace import Trace

DOCUMENTS_MODEL = config.DOCUMENTS_MODEL


@dataclass
class RoutedReply:
    text: str
    category: str
    trace: Trace


class RoutedComptoir:
    def __init__(self, client, shop, budget, conversation: str, base: list[Chunk],
                 documents_model: str = DOCUMENTS_MODEL, cache: bool | str = "1h",
                 comptoir_model: str | None = None, prompt_version: str = "v5", documents_version: str = "v1",
                 comptoir_effort: str | None = None):
        """Chapter 17: comptoir_model, prompt_version and documents_version can be changed to
        evaluate a variant; the defaults are the shipped version (model: config.COMPTOIR_MODEL;
        prompt v5 since chapter 18, which tells the Comptoir that it is an AI).
        comptoir_effort (chapter 19): None for config.COMPTOIR_EFFORT (the model's default if it is empty).
        That effort was measured for the shipped model: it does not apply to another model being evaluated
        (chapter 20, caught by Claude's review)."""
        self.client, self.shop, self.conversation, self.base = client, shop, conversation, base
        self.documents_model, self.cache = documents_model, cache
        self.comptoir = ComptoirOrders(client, shop, budget, conversation, prompt_version=prompt_version,
                                       knowledge=base, cache=cache,
                                       model=comptoir_model or config.COMPTOIR_MODEL,
                                       effort=comptoir_effort or (config.COMPTOIR_EFFORT if comptoir_model is None
                                                                  else None))
        self.documents_prompt = doc_assistant.load_prompt(documents_version)

    def order_in_progress(self) -> bool:
        return any(status == "pending" for _, status, _, _ in self.shop.summaries(self.conversation))

    def _keep_the_thread(self, text: str, reply: str) -> None:
        self.comptoir.history.extend([
            {"role": "user", "content": customer_message(text)},
            {"role": "assistant", "content": [{"type": "text", "text": reply}]},
        ])

    def answer(self, text: str) -> RoutedReply:
        trace = Trace()
        with trace.step("routing", ROUTER_MODEL) as s:
            # The setting chosen by the measurement: Claude Haiku 5.5, no thinking.
            decision = route(self.client, text, order_in_progress=self.order_in_progress(), no_thinking=True)
            s.record(decision.cost, f"{decision.category} (by {decision.by})")
        category = decision.category

        if category == "information":
            reply = self._information(text, trace)
            if reply is not None:
                return RoutedReply(reply, category, trace)
            category = "information, fallback"  # a cut-off answer is not an answer: the Comptoir takes over
        if category == "complaint":
            result = complaints.handle(self.client, text, self.shop, self.conversation, trace)
            self._keep_the_thread(text, result.reply)
            return RoutedReply(result.reply, category, trace)
        with trace.step("comptoir", self.comptoir.prompt.id) as s:
            before = len(self.comptoir.history)
            r = self.comptoir.answer(text)
            s.record(_turn_cost(r), f"{len(self.comptoir.history) - before} messages added")
        return RoutedReply(r.text, category, trace)

    def _information(self, text: str, trace: Trace) -> str | None:
        with trace.step("documents", self.documents_model) as s:
            r = doc_assistant.answer(self.client, text, self.base, self.documents_prompt, cache=self.cache,
                                     mode="routed", model=self.documents_model, no_thinking=True,
                                     with_citations=False)
            s.record(r.cost.dollars, r.stop)
        if r.stop != "end_turn" or not r.plain_text:
            return None
        if announces_pass_on(r.plain_text):
            # Chapter 18: the document assistant has no tool. A pass-on it announces
            # will not take place: its answer is not sent, the Comptoir, which has the tool, takes over.
            trace.add("guard", "code", 0, 0.0, "pass-on announced without a tool: handed over to the Comptoir")
            return None
        self._keep_the_thread(text, r.plain_text)
        return r.plain_text


def _turn_cost(reply) -> float:
    """The cost of the calls made by the Comptoir during this turn (0 for a confirmation read by the code)."""
    return reply.turn.cost if reply.turn else 0.0
