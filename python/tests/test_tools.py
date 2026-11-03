"""The definitions of the tools, and their execution without an exception toward the loop."""

import json
import re
from types import SimpleNamespace

from comptoir.shop import Shop
from comptoir.tools import TOOLS, Execution, Tools


def _objects(schema):
    """All the objects of a schema, nested ones included."""
    if schema.get("type") == "object":
        yield schema
        for prop in schema["properties"].values():
            yield from _objects(prop)
    if schema.get("type") == "array":
        yield from _objects(schema["items"])


def test_strict_and_well_described_definitions():
    for tool in TOOLS:
        assert re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", tool["name"])
        assert tool["strict"] is True
        # Anthropic advises at least three or four sentences per description.
        assert tool["description"].count(". ") + 1 >= 3, tool["name"]
        for obj in _objects(tool["input_schema"]):
            assert obj["additionalProperties"] is False
            assert set(obj["required"]) == set(obj["properties"])


def call(name, tool_input, call_id="toolu_1"):
    return SimpleNamespace(type="tool_use", id=call_id, name=name, input=tool_input)


def test_the_stock_of_several_products():
    tools = Tools(Shop(), "c1")
    result = tools.execute(call("stock_check", {"products": ["Pineapple juice", "Mango juice"]}), Execution())
    assert json.loads(result["content"]) == {"Pineapple juice": 12, "Mango juice": "missing from the catalog"}
    assert "is_error" not in result


def test_a_shop_error_becomes_a_result_in_error():
    tools = Tools(Shop(), "c1")
    tool_input = {"lines": [{"product": "Mango juice", "quantity": 3}], "customer_name": "A", "neighborhood": "B"}
    result = tools.execute(call("order_prepare", tool_input), Execution())
    assert result["is_error"] is True and "missing from the catalog" in result["content"]


def test_claude_does_not_receive_the_confirmation_code():
    tools, execution = Tools(Shop(), "c1"), Execution()
    tool_input = {"lines": [{"product": "Bissap juice", "quantity": 6}], "customer_name": "A", "neighborhood": "B"}
    result = json.loads(tools.execute(call("order_prepare", tool_input), execution)["content"])
    assert "confirmation_code" not in result and result["total_fcfa"] == 6000
    assert execution.summary["confirmation_code"]  # the code, for its part, keeps it to display it


def test_an_unknown_tool():
    result = Tools(Shop(), "c1").execute(call("order_create", {}), Execution())
    assert result["is_error"] and "Unknown" in result["content"]


def test_the_pass_on_to_awa():
    shop = Shop()
    execution = Execution()
    Tools(shop, "c1").execute(call("pass_to_awa", {"reason": "discount", "summary": "20% off for 10 bottles"}), execution)
    assert shop.requests()[0][1:3] == ("c1", "discount") and execution.passed_on
