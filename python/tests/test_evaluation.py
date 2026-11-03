"""The comparison of two prompt versions, with a fake client: no paid call."""

from types import SimpleNamespace

import pytest
from anthropic.types import Usage

from ch05 import evaluate_prompt
from comptoir.evaluation import Trial, evaluate, read_csv, regrade, regressions, summarize, write_csv
from comptoir.notation import Case


class FakeClient:
    """The “v1” version answers the price case right; “v0” only the discount case."""

    def __init__(self):
        self.messages = self

    def create(self, **request):
        v1 = "customer_message" in request["messages"][-1]["content"]
        question = request["messages"][-1]["content"]
        if "price" in question:
            text = "It's 2,500 FCFA." if v1 else "It's 3,000 FCFA."
        else:
            text = "I'm passing it on to Awa." if not v1 else "All right, 10% off for you."
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=text)],
            stop_reason="end_turn",
            usage=Usage(input_tokens=1000, output_tokens=100),
            _request_id="req_test",
        )


CASES = [
    Case("price", "The price of the syrup?", must_contain=["2,500"]),
    Case("discount", "A discount?", must_pass_on=True),
]


@pytest.fixture(autouse=True)
def temporary_log(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.LOG", str(tmp_path / "calls.jsonl"))
    monkeypatch.setattr("comptoir.config.MODEL", "claude-sonnet-5-5")


def test_the_two_versions_and_the_regression():
    trials = evaluate(FakeClient(), CASES, evaluate_prompt.VARIANTS, repetitions=2, max_budget=10)
    assert len(trials) == 2 * 2 * 2
    summary = {l["variant"]: l for l in summarize(trials)}
    assert summary["v0"]["success"] == summary["v1"]["success"] == 0.5
    # Same overall score, but v1 breaks a case that v0 passed: it is a regression.
    assert regressions(trials, "v0", "v1") == ["discount"]


def test_only_the_prompt_changes_between_variants():
    case = CASES[0]
    v0, v1 = evaluate_prompt.request_v0(case), evaluate_prompt.request_v1(case)
    assert v0["model"] == v1["model"] and v0["max_tokens"] == v1["max_tokens"]
    assert v0.get("output_config") == v1.get("output_config")
    assert v0["system"] != v1["system"]


def test_the_budget_stops_the_evaluation():
    # A call costs $0.003 on Sonnet 5.5: with $0.004, it stops after the second one.
    trials = evaluate(FakeClient(), CASES, evaluate_prompt.VARIANTS, repetitions=3, max_budget=0.004)
    assert len(trials) == 2


def test_the_twenty_cases_of_the_chapter():
    cases = evaluate_prompt.load_cases()
    assert len(cases) == 20
    assert len({c.id for c in cases}) == 20


def test_regrade_rereads_the_answers_without_a_call(tmp_path):
    cases = [Case("short", "?", must_contain=["1,000"])]
    text = "Hello! The juice is 1,000 FCFA. It can be ordered on WhatsApp. Anything else?"
    old = Trial("v1", "short", 1, False, "more than 3 sentences", "", text, 1.2, 1700, 60, 0.004, "end_turn")
    cut = Trial("v1", "short", 2, False, "", "", "1,000 FCFA", 1.0, 1700, 2000, 0.02, "max_tokens")
    write_csv([old, cut], tmp_path / "trials.csv")
    reread = read_csv(tmp_path / "trials.csv")
    assert reread == [old, cut]  # the types come back intact: integers, floats, booleans
    regraded = regrade(reread, cases)
    assert regraded[0].passed and regraded[0].reasons == ""  # “Hello!” no longer counts as a sentence
    assert not regraded[1].passed and "max_tokens" in regraded[1].reasons  # the stop rule remains
    assert regraded[0].cost_dollars == 0.004  # the cost is that of the original call: nothing is called again
