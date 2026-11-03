"""The comparison of models, with a fake client that imitates two models: no paid call."""

from types import SimpleNamespace

import pytest
from anthropic.types import OutputTokensDetails, Usage

from ch03 import compare_models as cm
from comptoir.notation import Case


class FakeClient:
    """The “big” model answers right; the “small” one gets the syrup price wrong."""

    def __init__(self):
        self.messages = self
        self.requests = []

    def create(self, **request):
        self.requests.append(request)
        question = request["messages"][0]["content"]
        right_price = request["model"] == "claude-opus-5-5" or "syrup" not in question
        text = "The syrup costs 2,500 FCFA." if right_price else "The syrup costs 3,000 FCFA."
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=text)],
            stop_reason="end_turn",
            usage=Usage(input_tokens=500, output_tokens=100,
                        output_tokens_details=OutputTokensDetails(thinking_tokens=40)),
            _request_id="req_test",
        )

    def count_tokens(self, **request):
        return SimpleNamespace(input_tokens=500)


CASES = [
    Case("syrup-price", "How much is the syrup?", must_contain=["2,500"]),
    Case("other", "And the juice?", must_contain=["2,500"]),
]
CONFIGS = [("claude-opus-5-5", "medium"), ("claude-haiku-5-5", "low")]


@pytest.fixture(autouse=True)
def temporary_log(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.LOG", str(tmp_path / "calls.jsonl"))


def test_each_case_is_repeated_for_each_configuration():
    client = FakeClient()
    trials = cm.compare(client, CASES, CONFIGS, repetitions=3, max_budget=10)
    assert len(trials) == 2 * 2 * 3
    assert {r["output_config"]["effort"] for r in client.requests} == {"medium", "low"}
    assert all("temperature" not in r for r in client.requests)


def test_cost_per_successful_task():
    trials = cm.compare(FakeClient(), CASES, CONFIGS, repetitions=2, max_budget=10)
    summary = {(l["model"], l["effort"]): l for l in cm.summarize(trials)}

    opus = summary[("claude-opus-5-5", "medium")]
    haiku = summary[("claude-haiku-5-5", "low")]
    assert opus["success"] == 1.0
    assert haiku["success"] == 0.5
    haiku_cost = (500 * 0.10 + 100 * 0.50) / 1e6
    # The small model succeeds only once in two: its success costs two calls.
    assert haiku["cost_per_success"] == pytest.approx(2 * haiku_cost)
    assert opus["average_thinking"] == 40


def test_the_budget_stops_the_comparison():
    # An Opus call costs $0.004 here: with a $0.005 budget, it stops after the second one.
    trials = cm.compare(FakeClient(), CASES, CONFIGS, repetitions=3, max_budget=0.005)
    assert len(trials) == 2


def test_free_estimate():
    total = cm.estimate(FakeClient(), CASES, CONFIGS, repetitions=1, assumed_output=100)
    expected = 2 * (500 * 4 + 100 * 20) / 1e6 + 2 * (500 * 0.10 + 100 * 0.50) / 1e6
    assert total == pytest.approx(expected)


def test_the_books_cases_load():
    cases = cm.load_cases()
    assert len(cases) == 15
    assert len({c.id for c in cases}) == 15
