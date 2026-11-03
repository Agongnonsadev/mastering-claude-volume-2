"""The robust call of chapter 8, with a fake synchronous client: budget, log, diagnoses."""

import json
from types import SimpleNamespace

import anthropic
import httpx2
import pytest
from anthropic.types import TextBlock, Usage

from comptoir.budget import Budget
from comptoir.call import OverBudget, call_claude
from comptoir.errors import ComptoirError

REQUEST = {"model": "claude-sonnet-5-5", "max_tokens": 2000, "system": "s", "messages": [{"role": "user", "content": "Hello"}]}


@pytest.fixture(autouse=True)
def log(tmp_path, monkeypatch):
    path = tmp_path / "calls.jsonl"
    monkeypatch.setattr("comptoir.config.LOG", str(path))
    monkeypatch.setattr("comptoir.config.CUSTOMER_DAILY_QUOTA", 0.15)
    monkeypatch.setattr("comptoir.config.DAILY_BUDGET", 1.30)
    monkeypatch.setattr("comptoir.config.MONTHLY_BUDGET", 26.0)
    return path


def lines(path):
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()]


class FakeClient:
    def __init__(self, error=None, stop_reason="end_turn"):
        self.messages = self
        self.error, self.stop_reason = error, stop_reason
        self.calls = 0

    def count_tokens(self, **request):
        assert "max_tokens" not in request  # the counting tool does not take it
        return SimpleNamespace(input_tokens=1000)

    def create(self, **request):
        self.calls += 1
        if self.error:
            raise self.error
        return SimpleNamespace(
            content=[TextBlock(type="text", text="Hello!")],
            stop_reason=self.stop_reason,
            stop_details=SimpleNamespace(category="general_harms") if self.stop_reason == "refusal" else None,
            usage=Usage(input_tokens=1000, output_tokens=100),
            _request_id="req_test",
        )


def test_a_successful_call_settles_the_real_cost_and_is_logged(log):
    budget = Budget()
    reply = call_claude(FakeClient(), REQUEST, budget, "c1")
    assert reply.text == "Hello!" and reply.stop is None
    assert budget.for_customer("c1") == pytest.approx(reply.cost.dollars)  # not the reserved maximum
    line = lines(log)[0]
    assert line["customer"] == "c1" and line["stop_reason"] == "end_turn" and "duration_ms" in line


def test_over_budget_no_call_goes_out(log, monkeypatch):
    monkeypatch.setattr("comptoir.config.CUSTOMER_DAILY_QUOTA", 0.0001)
    client = FakeClient()
    with pytest.raises(OverBudget):
        call_claude(client, REQUEST, Budget(), "c1")
    assert client.calls == 0
    assert lines(log)[0] == {**lines(log)[0], "event": "over_budget", "reason": "customer_quota"}


def test_an_api_error_releases_the_reservation(log):
    response = httpx2.Response(401, request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))
    budget = Budget()
    with pytest.raises(ComptoirError) as error:
        call_claude(FakeClient(anthropic.AuthenticationError("Key", response=response, body=None)), REQUEST, budget, "c1")
    assert error.value.diagnostic.code == "invalid_key"
    assert budget.for_day() == 0  # an error returned by the API is not billed
    assert lines(log)[0]["error"] == "invalid_key"


def test_a_network_cut_keeps_the_reservation():
    budget = Budget()
    with pytest.raises(ComptoirError):
        call_claude(FakeClient(httpx2.RemoteProtocolError("cut")), REQUEST, budget, "c1")
    assert budget.for_day() > 0  # the request may have gone through without the answer arriving


def test_a_refusal_arrives_like_a_normal_answer(log):
    reply = call_claude(FakeClient(stop_reason="refusal"), REQUEST, Budget(), "c1")
    assert reply.stop.code == "refusal" and "general_harms" in reply.stop.for_yao
    assert lines(log)[0]["error"] == "refusal"
