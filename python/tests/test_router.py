"""The router, the trace and the vote, with a fake client: no paid call."""

import json
from types import SimpleNamespace

import pytest
from anthropic.types import Usage

from comptoir import router
from comptoir.router import CATEGORIES, Decision, RoutingImpossible, classify, route, routing_request, vote
from comptoir.trace import Trace


@pytest.fixture(autouse=True)
def log(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.LOG", str(tmp_path / "calls.jsonl"))


class FakeClient:
    def __init__(self, *responses):
        self.messages, self.responses, self.requests = self, list(responses), []

    def create(self, **request):
        self.requests.append(request)
        text, stop = self.responses.pop(0)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)], stop_reason=stop,
                               usage=Usage(input_tokens=1100, output_tokens=40), _request_id="req")


def json_category(category):
    return json.dumps({"category": category, "reason": "test"}), "end_turn"


def test_the_request_sees_only_the_message():
    request = routing_request("Do you deliver on Sundays?", no_thinking=True)
    assert request["model"] == "claude-haiku-5-5" and "tools" not in request
    assert request["thinking"] == {"type": "disabled"}
    assert request["output_config"]["format"]["schema"]["properties"]["category"]["enum"] == list(CATEGORIES)
    assert request["messages"][0]["content"].startswith("<customer_message>")


def test_a_classification_and_its_cost():
    decision = classify(FakeClient(json_category("information")), "Do you deliver on Sundays?")
    assert decision.category == "information" and decision.by == "claude-haiku-5-5"
    assert decision.cost == pytest.approx((1100 * 0.10 + 40 * 0.50) / 1e6)


def test_a_cut_off_or_invented_answer_is_a_routing_impossible():
    with pytest.raises(RoutingImpossible):
        classify(FakeClient(('{"category": "inf', "max_tokens")), "?")
    with pytest.raises(RoutingImpossible):
        classify(FakeClient(json_category("refund")), "?")
    # The case of an enum value is not guaranteed: compared without it.
    assert classify(FakeClient(json_category("Information")), "?").category == "information"
    # In production, the message goes to the Comptoir, which can handle everything.
    decision = route(FakeClient(('{"categ', "max_tokens")), "?")
    assert decision.category == "other" and decision.by == "fallback"


def test_the_code_decides_what_it_knows():
    client = FakeClient()
    assert route(client, "YES 4821").by == "code" and client.requests == []  # no call


def test_during_an_order_what_follows_goes_to_the_comptoir_except_a_complaint():
    assert route(FakeClient(json_category("information")), "And on Sundays?", order_in_progress=True).category == "order"
    assert route(FakeClient(json_category("complaint")), "It's lukewarm!", order_in_progress=True).category == "complaint"


def test_the_vote_and_the_tie():
    d = lambda c: Decision(c, "", "m")  # noqa: E731
    assert vote([d("order"), d("information"), d("order")]) == "order"
    # In case of a tie, the highest priority category: a complaint does not get lost.
    assert vote([d("information"), d("complaint")]) == "complaint"


def test_the_vote_in_parallel(monkeypatch):
    client = FakeClient(json_category("order"), json_category("information"), json_category("order"))
    winner, decisions = router.route_by_vote(client, "?", votes=3)
    assert winner == "order" and len(decisions) == 3


def test_the_trace_of_a_processing(tmp_path):
    trace = Trace()
    with trace.step("routing", "claude-haiku-5-5") as s:
        s.record(0.0001, "information")
    with pytest.raises(ValueError):
        with trace.step("documents", "claude-haiku-5-5"):
            raise ValueError("outage")
    assert [s.name for s in trace.steps] == ["routing", "documents"]
    assert trace.steps[1].error == "ValueError" and trace.cost == pytest.approx(0.0001)
    assert "routing" in trace.show() and "ERROR ValueError" in trace.show()
    lines = [json.loads(l) for l in open(tmp_path / "calls.jsonl", encoding="utf-8")]
    assert [l["step"] for l in lines] == ["routing", "documents"] and lines[0]["trace"] == trace.id
    assert "message" not in lines[0]  # never the customer's text


def test_the_test_messages_are_well_formed():
    from ch12.evaluate_router import load_messages
    messages = load_messages()
    assert len(messages) == 30 and len({m["id"] for m in messages}) == 30
    assert {m["expected"] for m in messages} <= set(CATEGORIES)
