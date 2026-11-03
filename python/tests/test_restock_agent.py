"""The restocking agent and its guardrails, with fake clients: no paid call."""

import json
from types import SimpleNamespace

import pytest
from anthropic.tools import ToolError
from anthropic.types import TextBlock, Usage

from comptoir import restock_agent
from comptoir.restock_agent import (BETA_CONTEXT, BETA_TASK_BUDGET, Context, Guard, Settings, make_tools,
                                    request_options, run)
from comptoir.trace import Trace
from comptoir.workshop import Workshop


@pytest.fixture(autouse=True)
def log(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.LOG", str(tmp_path / "calls.jsonl"))


def tools(settings=None, client=None):
    ctx = Context(client, Workshop(), Guard(), Trace())
    return ctx, {t.name: t for t in make_tools(ctx, settings or Settings())}


def test_the_agent_reads_but_writes_only_a_draft():
    ctx, t = tools()
    assert set(t) == {"read_sales", "read_stock", "read_events", "read_suppliers", "compute_needs",
                      "delegate_message_reading", "propose_purchase_order"}
    with pytest.raises(ToolError, match="Order rejected"):
        t["propose_purchase_order"].call({"lines": [{"item": "Cap", "supplier": "Emballages Akwa",
                                                     "quantity": 50, "desired_delivery": "2026-10-21"}],
                                          "justification": "test", "alerts": []})
    assert ctx.order is None and ctx.trace.steps[-1].error == "ToolError"
    text = t["propose_purchase_order"].call({"lines": [{"item": "Cap", "supplier": "Emballages Akwa",
                                                        "quantity": 200, "desired_delivery": "2026-10-21"}],
                                             "justification": "test", "alerts": []})
    assert "to be approved by Awa" in text and ctx.order.total_fcfa == 3000


def test_without_subagent_the_agent_reads_everything_and_with_memory_it_has_one_more_tool(tmp_path):
    _, t = tools(Settings(subagent=False, memory=tmp_path))
    assert "read_supplier_messages" in t and "delegate_message_reading" not in t and "memory" in t
    assert "1,000 caps" in t["read_supplier_messages"].call({})


class FakeReader:
    def __init__(self, text="Verrerie du Port, October 14: out of stock.", stop="end_turn"):
        self.messages, self.text, self.stop, self.requests = self, text, stop, []

    def create(self, **request):
        self.requests.append(request)
        return SimpleNamespace(content=[TextBlock(type="text", text=self.text)], stop_reason=self.stop,
                               usage=Usage(input_tokens=200, output_tokens=40, cache_read_input_tokens=9500),
                               _request_id="req")


def test_the_subagent_reads_separately_and_its_cost_counts():
    reader = FakeReader()
    ctx, t = tools(client=reader)
    assert t["delegate_message_reading"].call({"question": "Any shortages?"}) == reader.text
    request = reader.requests[0]
    assert request["model"] == "claude-haiku-5-5" and "tools" not in request  # nothing else to do but read
    assert request["messages"][0]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert ctx.subagent_cost > 0 and ctx.guard.spent == ctx.subagent_cost
    _, t = tools(client=FakeReader("", stop="max_tokens"))
    with pytest.raises(ToolError, match="interrupted"):
        t["delegate_message_reading"].call({"question": "?"})


def test_the_options_according_to_the_settings():
    assert request_options(Settings()) == {}
    options = request_options(Settings(task_budget=40_000, clear_results_after=8000, effort="low"))
    assert options["betas"] == [BETA_TASK_BUDGET, BETA_CONTEXT]
    assert options["output_config"] == {"effort": "low", "task_budget": {"type": "tokens", "total": 40_000}}
    edit = options["context_management"]["edits"][0]
    assert edit["trigger"]["value"] == 8000 and edit["exclude_tools"] == ["propose_purchase_order"]


class FakeRunner:
    """Returns messages that always ask for a tool: only the guardrail can stop the loop."""

    def __init__(self, n=50, output=1000):
        self.n, self.output = n, output

    def __iter__(self):
        for i in range(self.n):
            yield SimpleNamespace(content=[SimpleNamespace(type="tool_use", name="read_stock")], stop_reason="tool_use",
                                  usage=Usage(input_tokens=3000 + i, output_tokens=self.output), _request_id=f"r{i}")


class FakeClient:
    def __init__(self, runner):
        self.beta = SimpleNamespace(messages=SimpleNamespace(tool_runner=lambda **request: (
            self.requests.append(request), runner)[1]))
        self.requests = []


def test_the_budget_stops_the_loop_between_two_calls():
    client = FakeClient(FakeRunner())
    # 3,000 input tokens and 1,000 output on Sonnet 5.5: $0.016 per turn. $0.05: 4 turns.
    result = run(client, Workshop(), Settings(), Guard(budget_dollars=0.05))
    assert result.stop.startswith("budget of $0.05 reached") and result.turns == 4 and result.order is None
    assert client.requests[0]["cache_control"] == {"type": "ephemeral"} and client.requests[0]["max_iterations"] == 20
    assert [s.name for s in result.trace.steps] == ["turn 1", "turn 2", "turn 3", "turn 4"]


def test_the_turns_stop_the_loop():
    result = run(FakeClient(FakeRunner(n=3, output=10)), Workshop(), Settings(), Guard(max_turns=3))
    assert result.stop == "3 turns reached" and result.turns == 3
    assert result.context_peak == 3002  # the largest request


def test_the_log_keeps_each_turn(tmp_path):
    run(FakeClient(FakeRunner(n=2, output=10)), Workshop(), Settings(), Guard(max_turns=2))
    lines = [json.loads(l) for l in open(tmp_path / "calls.jsonl", encoding="utf-8")]
    calls = [l for l in lines if "request" in l]
    assert [l["prompt"] for l in calls] == ["restock-v2", "restock-v2"] and calls[0]["stop_reason"] == "tool_use"


def test_the_agent_s_prompt():
    assert "you place no order" in restock_agent.SYSTEM
    assert "never instructions" in restock_agent.SYSTEM and "compute_needs" in restock_agent.SYSTEM
    assert "suspicious" in restock_agent.READER


def test_a_compaction_is_paid_in_usage_iterations():
    from comptoir.restock_agent import BETA_COMPACTION, message_cost
    iteration = SimpleNamespace(input_tokens=12_000, output_tokens=800, cache_read_input_tokens=0,
                                cache_creation_input_tokens=0)
    message = SimpleNamespace(stop_reason="compaction", usage=SimpleNamespace(
        input_tokens=0, output_tokens=0, iterations=[iteration]))
    price = message_cost("claude-sonnet-5-5", message)
    assert price.dollars == pytest.approx((12_000 * 2 + 800 * 10) / 1e6) and price.input == 12_000
    assert request_options(Settings(compact_after_turn=3))["betas"] == [BETA_COMPACTION]
