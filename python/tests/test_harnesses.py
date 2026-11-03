"""The same agent in two other harnesses: the Claude Agent SDK and Managed Agents. No call."""

import asyncio

import pytest

pytest.importorskip("claude_agent_sdk")  # the [agents] extra: pip install -e ".[tests,agents]"

from ch13.with_agent_sdk import READING, guard, options
from ch13.with_managed_agents import custom_tools, execute, without_references
from comptoir.restock_agent import Context, Guard, Settings, make_tools
from comptoir.trace import Trace
from comptoir.workshop import Workshop


@pytest.fixture(autouse=True)
def log(tmp_path, monkeypatch):
    # The tools run here record their steps in the log: never in log/calls.jsonl.
    monkeypatch.setattr("comptoir.config.LOG", str(tmp_path / "calls.jsonl"))


def decision(hook_input: dict) -> str | None:
    output = asyncio.run(guard(hook_input, "toolu_1", None))
    return output.get("hookSpecificOutput", {}).get("permissionDecision")


def test_the_hook_reserves_message_reading_for_the_subagent():
    assert decision({"tool_name": READING}) == "deny"                                  # the main agent
    assert decision({"tool_name": READING, "agent_id": "a1", "agent_type": "reader"}) is None  # the subagent
    assert decision({"tool_name": "Bash"}) == "deny"
    assert decision({"tool_name": "Agent"}) is None
    assert decision({"tool_name": "mcp__workshop__read_stock"}) is None


def test_the_sdk_options_open_nothing_more(tmp_path):
    ctx = Context(None, Workshop(), Guard(), Trace())
    o = options(ctx, 0.60, str(tmp_path))
    assert o.tools == ["Agent"] and o.permission_mode == "dontAsk" and o.setting_sources == []
    assert o.agents["reader"].tools == [READING] and o.agents["reader"].model == "claude-haiku-5-5"
    assert o.max_budget_usd == 0.60 and o.env["CLAUDE_CONFIG_DIR"].startswith(str(tmp_path))


def test_the_custom_tools_have_a_schema_in_one_block():
    tools = make_tools(Context(None, Workshop(), Guard(), Trace()), Settings())
    propose = next(t for t in custom_tools(tools) if t["name"] == "propose_purchase_order")
    assert propose["type"] == "custom" and "$defs" not in str(propose["input_schema"])
    line = propose["input_schema"]["properties"]["lines"]["items"]
    assert line["properties"]["desired_delivery"]["type"] == "string"
    assert without_references({"type": "object", "properties": {"a": {"type": "string"}}}) == {
        "type": "object", "properties": {"a": {"type": "string"}}}


def test_a_tool_error_comes_back_as_an_error():
    tools = {t.name: t for t in make_tools(Context(None, Workshop(), Guard(), Trace()), Settings())}
    text, error = execute(tools, "compute_needs", {"production": {"Baobab juice": 3}})
    assert error and "unknown products" in text
    text, error = execute(tools, "read_stock", {})
    assert not error and "finished_products" in text


def test_the_monday_schedule_calls_nothing_by_default():
    from ch13.schedule_monday import MONDAY_7AM, request
    body = request("agent_x", "env_x", 50)
    assert MONDAY_7AM == {"type": "cron", "expression": "0 7 * * 1", "timezone": "Africa/Porto-Novo"}
    assert body["budget"]["max_list_cost"] == {"amount": "50", "currency": "USD"}
    assert body["initial_events"][0]["type"] == "user.message"
