"""The restocking agent: a framed agent loop (chapter 13).

Claude reads the sales, the stock, the events, the sheets and the suppliers' messages,
has the needs calculated by a tool, then proposes a purchase order. It chooses itself what
it reads and in what order: it is an agent. The code frames it:
- a number of turns, a budget in dollars and a timeout, checked between two calls;
- optionally, a task budget (in beta), so that Claude adjusts its own effort;
- a single tool that writes, and it writes only a draft: the order is checked by the code and stays
  “to be approved by Awa”; nothing is sent;
- a trace: each call and each tool, with its duration and its cost;
- optionally: the reading of the messages entrusted to a subagent, a memory from one week to
  the next, the clearing of old tool results.
"""

import json
import time
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import TypedDict

from anthropic import beta_tool
from anthropic.tools import BetaLocalFilesystemMemoryTool, ToolError

from comptoir import config
from comptoir.costs import Cost, cost
from comptoir.log import log_call
from comptoir.trace import Trace
from comptoir.workshop import InvalidOrder, Order, Workshop, render_order

PROMPTS = Path(__file__).parent / "prompts"
SYSTEM = (PROMPTS / "restock_v2.md").read_text(encoding="utf-8").strip()
READER = (PROMPTS / "reader_v1.md").read_text(encoding="utf-8").strip()
INSTRUCTION = "It is Monday, October 19, 2026, 7 a.m. Prepare the week's draft purchase order."
READER_MODEL = config.AUXILIARY_MODEL  # Claude Haiku 5.5: reading and summarizing, without tools

BETA_TASK_BUDGET = "task-budgets-2026-03-13"
BETA_CONTEXT = "context-management-2025-06-27"
BETA_COMPACTION = "compact-2026-09-04"


class OrderLine(TypedDict):
    item: str
    supplier: str
    quantity: float
    desired_delivery: str


@dataclass
class Settings:
    model: str = config.MODEL
    effort: str | None = None
    subagent: bool = True                    # the reading of the messages entrusted to Claude Haiku 5.5
    memory: Path | None = None               # a folder: the memory tool, from one week to the next
    task_budget: int | None = None           # in tokens, 20,000 at least (beta)
    clear_results_after: int | None = None   # input tokens beyond which the old results are cleared
    compact_after_turn: int | None = None    # summarize the session after this turn (on-demand compaction, beta)
    max_tokens: int = 8000


@dataclass
class Guard:
    """The limits that the code checks between two calls: we stop before paying for the next one."""
    max_turns: int = 20
    budget_dollars: float = 0.50
    timeout_s: float = 300.0
    turns: int = 0
    spent: float = 0.0
    start: float = field(default_factory=time.perf_counter)

    def reason_to_stop(self) -> str | None:
        if self.spent >= self.budget_dollars:
            return f"budget of ${self.budget_dollars:.2f} reached (${self.spent:.4f})"
        if time.perf_counter() - self.start >= self.timeout_s:
            return f"timeout of {self.timeout_s:.0f} s exceeded"
        if self.turns >= self.max_turns:
            return f"{self.max_turns} turns reached"
        return None


@dataclass
class Result:
    text: str
    order: Order | None
    stop: str | None             # None: the agent finished on its own
    turns: int
    spent: float
    duration_s: float
    context_peak: int            # the largest request of the session, in input tokens
    tools: list[str]
    subagent_cost: float
    clearings: list[dict]
    trace: Trace


@dataclass
class Context:
    client: object
    workshop: Workshop
    guard: Guard
    trace: Trace
    order: Order | None = None
    tools: list[str] = field(default_factory=list)
    subagent_cost: float = 0.0


def read_by_subagent(client, messages: str, question: str) -> tuple[str, float]:
    """The subagent: Claude Haiku 5.5, without tools, with the messages and a question. Its context is
    its own: the main agent receives only the answer, not the thousands of words it took to read."""
    request = {"model": READER_MODEL, "max_tokens": 1000, "thinking": {"type": "disabled"}, "system": READER,
               "messages": [{"role": "user", "content": [
                   # The messages do not change from one question to the next: cached.
                   {"type": "text", "text": f"<messages>\n{messages}\n</messages>", "cache_control": {"type": "ephemeral"}},
                   {"type": "text", "text": f"<question>{question}</question>"}]}]}
    response = client.messages.create(**request)
    price = cost(READER_MODEL, response.usage)
    log_call(response._request_id, READER_MODEL, price, prompt="reader-v1", stop_reason=response.stop_reason)
    text = "".join(b.text for b in response.content if b.type == "text").strip()
    if response.stop_reason != "end_turn" or not text:
        raise ToolError(f"Reading interrupted (stop: {response.stop_reason}). Ask a more precise question.")
    return text, price.dollars


def make_tools(ctx: Context, settings: Settings) -> list:
    workshop = ctx.workshop

    @beta_tool
    def read_sales() -> str:
        """Returns the usual sales of the last eight weeks, product by product and week by week,
        their averages calculated by the code, and the past event orders set apart. To read in order to plan the
        production of the next two weeks."""
        with ctx.trace.step("read_sales") as s:
            ctx.tools.append("read_sales")
            s.record(0, "8 weeks")
            return workshop.sales_summary()

    @beta_tool
    def read_stock() -> str:
        """Returns this morning's stock: the finished products (bottles and flasks ready to sell) and the items
        (ingredients and packaging), in the unit of their sheets."""
        with ctx.trace.step("read_stock") as s:
            ctx.tools.append("read_stock")
            s.record(0, "morning stock")
            return json.dumps({k: v for k, v in workshop.stock().items() if k != "_note"}, ensure_ascii=False)

    @beta_tool
    def read_events() -> str:
        """Returns the upcoming event orders, with their date, their bottles and their status: confirmed
        (deposit paid) or a mere quote."""
        with ctx.trace.step("read_events") as s:
            ctx.tools.append("read_events")
            s.record(0, f"{len(workshop.events())} events")
            return json.dumps(workshop.events(), ensure_ascii=False)

    @beta_tool
    def read_suppliers() -> str:
        """Returns the suppliers' sheets: for each item, who sells it, the usual delivery lead time in
        days, the minimum order, the pack size and the unit price in FCFA. The sheets mention neither
        shortages, nor exceptional delays, nor announced price increases: see the messages."""
        with ctx.trace.step("read_suppliers") as s:
            ctx.tools.append("read_suppliers")
            s.record(0, f"{len(workshop.offers())} offers")
            return json.dumps(workshop.offers(), ensure_ascii=False)

    @beta_tool
    def compute_needs(production: dict[str, int]) -> str:
        """Calculates, for a production of bottles and flasks, the items needed (ingredients and
        packaging), the stock of each item, what is missing, and the quantity to order from each supplier
        according to their sheets (minimum and pack size). Takes into account neither shortages nor lead times:
        the choice of the supplier and the date is yours.

        Args:
            production: The number of bottles or flasks to produce, per product, with the exact names of the
                products, for example {"Bissap juice": 90}. Subtract the finished products already in stock.
        """
        with ctx.trace.step("compute_needs") as s:
            ctx.tools.append("compute_needs")
            try:
                needs = workshop.needs(production)
            except ValueError as error:
                raise ToolError(str(error)) from error
            s.record(0, f"{sum(production.values())} units to produce")
            return json.dumps(needs, ensure_ascii=False)

    @beta_tool
    def delegate_message_reading(question: str) -> str:
        """Entrusts the reading of the suppliers' WhatsApp messages (two months, several thousand words) to a
        reading assistant, which answers your question in a few dated sentences. To use in order to know the
        shortages, delays, exceptional lead times, price increases and new arrivals announced by the suppliers. A
        precise question gets a precise answer; you can ask several.

        Args:
            question: What you want to know, for example: "Which suppliers announce a shortage or a delay?"
        """
        with ctx.trace.step("message_reading", READER_MODEL) as s:
            ctx.tools.append("delegate_message_reading")
            answer, price = read_by_subagent(ctx.client, workshop.supplier_messages(), question)
            ctx.guard.spent += price
            ctx.subagent_cost += price
            s.record(price, f"{len(answer.split())} words")
            return answer

    @beta_tool
    def read_supplier_messages() -> str:
        """Returns all the suppliers' WhatsApp messages of the last two months, from the oldest to the most recent
        (several thousand words). They contain the shortages, delays, exceptional lead times, price increases and
        new arrivals, which are not in the sheets."""
        with ctx.trace.step("read_messages") as s:
            ctx.tools.append("read_supplier_messages")
            text = workshop.supplier_messages()
            s.record(0, f"{len(text.split())} words")
            return text

    @beta_tool
    def propose_purchase_order(lines: list[OrderLine], justification: str, alerts: list[str]) -> str:
        """Records the week's draft purchase order, to be approved by Awa. Nothing is sent to the
        suppliers. The code checks each line against the sheets (does the supplier sell the item, minimum,
        pack size, lead time) and Awa's ceiling, then calculates the amounts. If a rule is not respected,
        the order is rejected with the list of errors: correct it and propose it again. A new order replaces
        the previous one.

        Args:
            lines: The lines of the order: the item and the supplier written exactly as in the sheets, the
                quantity in the unit of the sheet, and the desired delivery date in the format YYYY-MM-DD.
            justification: For Awa, in a few sentences: the planned production, the choices of suppliers and dates.
            alerts: What Awa must know: shortages to expect, delays, price increases, suspicious messages,
                uncertainties. An empty list if there are none.
        """
        with ctx.trace.step("propose_order") as s:
            ctx.tools.append("propose_purchase_order")
            try:
                order = workshop.propose([dict(line) for line in lines], justification, alerts)
            except InvalidOrder as error:
                s.record(0, f"rejected, {len(error.errors)} errors")
                raise ToolError("Order rejected: " + "; ".join(error.errors)) from error
            if ctx.order is not None:
                workshop.withdraw(ctx.order.code, order.code)
            ctx.order = order
            s.record(0, f"{order.code}, {order.total_fcfa} FCFA")
            return render_order(order) + "\nThe order is awaiting Awa's approval."

    tools = [read_sales, read_stock, read_events, read_suppliers, compute_needs,
             delegate_message_reading if settings.subagent else read_supplier_messages,
             propose_purchase_order]
    if settings.memory is not None:
        tools.append(BetaLocalFilesystemMemoryTool(base_path=str(settings.memory)))
    return tools


def request_options(settings: Settings) -> dict:
    """The options of the request according to the settings: task budget, effort, clearing of the results."""
    options, betas, output = {}, [], {}
    if settings.effort:
        output["effort"] = settings.effort
    if settings.task_budget:
        betas.append(BETA_TASK_BUDGET)
        output["task_budget"] = {"type": "tokens", "total": settings.task_budget}
    if output:
        options["output_config"] = output
    if settings.compact_after_turn:
        betas.append(BETA_COMPACTION)
    if settings.clear_results_after:
        betas.append(BETA_CONTEXT)
        options["context_management"] = {"edits": [{
            "type": "clear_tool_uses_20250919",
            "trigger": {"type": "input_tokens", "value": settings.clear_results_after},
            "keep": {"type": "tool_uses", "value": 3},
            "exclude_tools": ["propose_purchase_order"],  # the last state of the order stays visible
        }]}
    if betas:
        options["betas"] = betas
    return options


def message_cost(model: str, message) -> Cost:
    """The cost of a message from the runner. A compaction has nothing in the top fields of usage: its
    cost is in usage.iterations, which must be added up (compaction documentation)."""
    iterations = getattr(message.usage, "iterations", None)
    if message.stop_reason == "compaction" and iterations:
        parts = [cost(model, iteration) for iteration in iterations]
        return Cost(*(sum(getattr(p, f.name) for p in parts) for f in fields(Cost)))
    return cost(model, message.usage)


def run(client, workshop: Workshop, settings: Settings | None = None, guard: Guard | None = None) -> Result:
    """One session of the agent, from the first call to the proposed order, or until a limit."""
    settings, guard = settings or Settings(), guard or Guard()
    ctx = Context(client, workshop, guard, Trace())
    runner = client.beta.messages.tool_runner(
        model=settings.model, max_tokens=settings.max_tokens, max_iterations=guard.max_turns, system=SYSTEM,
        tools=make_tools(ctx, settings), messages=[{"role": "user", "content": INSTRUCTION}],
        cache_control={"type": "ephemeral"},  # automatic caching: each turn rereads the previous one
        **request_options(settings))

    stop, last, peak, clearings = None, None, 0, []
    instant, already = time.perf_counter(), 0
    for message in runner:  # one message per call to Claude; the tools run between two messages
        guard.turns += 1
        price = message_cost(settings.model, message)
        guard.spent += price.dollars
        log_call(getattr(message, "_request_id", None), settings.model, price, prompt="restock-v2",
                 stop_reason=message.stop_reason)
        u = message.usage
        peak = max(peak, (u.input_tokens or 0) + (u.cache_read_input_tokens or 0) + (u.cache_creation_input_tokens or 0))
        management = getattr(message, "context_management", None)
        if management is not None and management.applied_edits:
            clearings += [e.model_dump() for e in management.applied_edits]
        # The duration of the call: the elapsed time, minus that of the tools run in between (already traced).
        now = time.perf_counter()
        tools_ms = sum(s.duration_ms for s in ctx.trace.steps[already:])
        calls = [b.name for b in message.content if b.type == "tool_use"]
        ctx.trace.add(f"turn {guard.turns}", settings.model, max(0, round((now - instant) * 1000) - tools_ms),
                      price.dollars, ", ".join(calls) or str(message.stop_reason))
        instant, already, last = now, len(ctx.trace.steps), message
        if settings.compact_after_turn == guard.turns and message.stop_reason == "tool_use":
            runner.compact_before_next_turn()  # after the tools of this turn, the history becomes a summary
        if message.stop_reason == "tool_use":
            stop = guard.reason_to_stop()
            if stop:
                break  # none of this turn's tools is run: nothing is half done
    if last is not None and last.stop_reason == "tool_use" and stop is None:
        stop = f"{guard.max_turns} turns reached"  # the runner stopped on its own, at max_iterations
    text = "".join(b.text for b in last.content if b.type == "text").strip() if last else ""
    return Result(text, ctx.order, stop, guard.turns, guard.spent, time.perf_counter() - guard.start, peak,
                  ctx.tools, ctx.subagent_cost, clearings, ctx.trace)
