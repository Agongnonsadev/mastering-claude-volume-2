"""The tool loop and the Comptoir that takes orders, with a fake client: no paid call."""

import json
import random
from types import SimpleNamespace

import pytest
from anthropic.types import TextBlock, ThinkingBlock, ToolUseBlock, Usage

from comptoir.budget import Budget
from comptoir.errors import REFUSAL, ComptoirError
from comptoir.loop import converse
from comptoir.orders import ComptoirOrders, render_summary
from comptoir.shop import Shop
from comptoir.tools import TOOLS, Tools


@pytest.fixture(autouse=True)
def settings(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.LOG", str(tmp_path / "calls.jsonl"))
    monkeypatch.setattr("comptoir.config.MODEL", "claude-sonnet-5-5")
    monkeypatch.setattr("comptoir.config.EFFORT", None)
    monkeypatch.setattr("comptoir.config.CUSTOMER_DAILY_QUOTA", 1.0)


def reply(*blocks, stop_reason="end_turn"):
    return SimpleNamespace(content=list(blocks), stop_reason=stop_reason, stop_details=None,
                           usage=Usage(input_tokens=1500, output_tokens=120), _request_id="req_test")


def tool(name, tool_input, call_id):
    return ToolUseBlock(type="tool_use", id=call_id, name=name, input=tool_input)


class FakeClient:
    """Returns the planned replies, one per call, and keeps each request received."""

    def __init__(self, *replies):
        self.messages = self
        self.replies = list(replies)
        self.requests = []

    def count_tokens(self, **request):
        return SimpleNamespace(input_tokens=1500)

    def create(self, **request):
        self.requests.append(json.loads(json.dumps(request, default=str)))
        return self.replies.pop(0)


REQUEST = {"model": "claude-sonnet-5-5", "max_tokens": 2000, "system": "s", "tools": TOOLS,
           "messages": [{"role": "user", "content": "Do you have any pineapple and ginger left?"}]}


def test_two_parallel_calls_return_their_results_in_one_message():
    client = FakeClient(
        reply(ThinkingBlock(type="thinking", thinking="", signature="sig"),
              tool("stock_check", {"products": ["Pineapple juice"]}, "t1"),
              tool("stock_check", {"products": ["Ginger juice"]}, "t2"), stop_reason="tool_use"),
        reply(TextBlock(type="text", text="Yes: 12 pineapples and 25 gingers.")),
    )
    turn = converse(client, REQUEST, Tools(Shop(), "c1"), Budget(), "c1")
    assert turn.text == "Yes: 12 pineapples and 25 gingers."
    second = client.requests[1]["messages"]
    assert second[1]["content"][0] == {"type": "thinking", "thinking": "", "signature": "sig"}  # intact
    results = second[2]["content"]
    assert [r["tool_use_id"] for r in results] == ["t1", "t2"] and len(second) == 3
    assert [m["role"] for m in turn.new_messages] == ["assistant", "user", "assistant"]


def test_a_loop_going_round_in_circles_is_stopped():
    loop = [reply(tool("stock_check", {"products": ["Pineapple juice"]}, f"t{i}"), stop_reason="tool_use")
            for i in range(3)]
    with pytest.raises(ComptoirError) as error:
        converse(FakeClient(*loop), REQUEST, Tools(Shop(), "c1"), Budget(), "c1", max_turns=3)
    assert error.value.diagnostic.code == "loop_too_long"


def comptoir(*replies):
    shop = Shop(rng=random.Random(7))
    return ComptoirOrders(FakeClient(*replies), shop, Budget(), "c1"), shop


PREPARE = {"lines": [{"product": "Bissap juice", "quantity": 6}], "customer_name": "Mrs. Hounkpè", "neighborhood": "Akpakpa"}


def test_from_order_to_confirmation():
    c, shop = comptoir(
        reply(tool("order_prepare", PREPARE, "t1"), stop_reason="tool_use"),
        reply(TextBlock(type="text", text="Here is your summary; check it before confirming.")),
    )
    first = c.answer("6 bissap to Akpakpa, in the name of Mrs. Hounkpè")
    # The total and the code shown to the customer come from the code, not from Claude.
    code = shop.summaries("c1")[0][0]
    assert "Total: 6,000 FCFA" in first.text and f"YES {code}" in first.text
    assert shop.orders() == []  # nothing is created before the confirmation

    confirmation = c.answer(f"yes {code}")
    assert confirmation.turn is None  # the confirmation did not go through Claude
    assert "C-0001" in confirmation.text and len(shop.orders()) == 1
    # The formatting of the amount must not swallow the sentence's comma (seen in a real measurement).
    assert "is recorded, for a total of 6,000 FCFA." in confirmation.text
    assert len(c.client.requests) == 2  # no extra call to confirm
    assert [m["role"] for m in c.history] == ["user", "assistant", "user", "assistant", "user", "assistant"]


def test_a_wrong_code_creates_nothing():
    c, shop = comptoir(
        reply(tool("order_prepare", PREPARE, "t1"), stop_reason="tool_use"),
        reply(TextBlock(type="text", text="Check the summary.")),
    )
    c.answer("6 bissap")
    code = shop.summaries("c1")[0][0]
    wrong = "0000" if code != "0000" else "1111"
    assert "could not confirm" in c.answer(f"YES {wrong}").text and shop.orders() == []


def test_a_refused_answer_does_not_enter_the_history():
    refusal = SimpleNamespace(content=[], stop_reason="refusal", stop_details=SimpleNamespace(category="general_harms"),
                              usage=Usage(input_tokens=1500, output_tokens=0), _request_id="req_test")
    c, _ = comptoir(refusal)
    assert c.answer("A refused request").text == REFUSAL and c.history == []


def test_the_official_summary():
    summary = Shop().prepare("c1", [{"product": "Bissap juice", "quantity": 2}], "Mr. Dossou", "Zogbo")
    text = render_summary(summary)
    assert "2 × Bissap juice: 2,000 FCFA" in text and "Delivery (Zogbo" in text and ": 500 FCFA" in text
    assert text.endswith(f"YES {summary['confirmation_code']}")


def test_awas_base_is_sent_but_never_recorded():
    # Chapter 11: the v3 Comptoir attaches the base to the first message of each request, with the cache.
    from comptoir.knowledge import load_knowledge

    client = FakeClient(reply(TextBlock(type="text", text="Hello!")), reply(TextBlock(type="text", text="Yes.")))
    c = ComptoirOrders(client, Shop(), Budget(), "c1", prompt_version="v3",
                       knowledge=load_knowledge()[:3], cache=True)
    c.answer("Hello")
    c.answer("Do you deliver on Sundays?")
    first, second = client.requests
    assert [b["type"] for b in first["messages"][0]["content"]][:3] == ["search_result"] * 3
    assert second["messages"][0] == first["messages"][0]  # same beginning of request: read from the cache
    assert first["cache_control"] == {"type": "ephemeral"} and first["tools"] == TOOLS
    assert isinstance(c.history[0]["content"], str)  # the history keeps the customer's message alone
