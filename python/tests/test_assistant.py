"""The Comptoir of chapter 5, with a fake client: no paid call."""

import json
from types import SimpleNamespace

from anthropic.types import Usage

from comptoir import assistant
from comptoir.prompt import load


class FakeClient:
    def __init__(self):
        self.messages = self
        self.request = None

    def create(self, **request):
        self.request = request
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text="The syrup costs 2,500 FCFA.")],
            stop_reason="end_turn",
            usage=Usage(input_tokens=900, output_tokens=60),
            _request_id="req_test",
        )


def test_the_request_tags_the_message_and_uses_prompt_v1():
    request = assistant.build_request("How much is the syrup?")
    assert request["system"] == load("v1").text
    assert request["messages"] == [
        {"role": "user", "content": "<customer_message>\nHow much is the syrup?\n</customer_message>"}
    ]
    assert "temperature" not in request


def test_awas_instruction_follows_the_customers_message():
    request = assistant.build_request("3 soursops tonight?", instructions=["Soursop out of stock."])
    roles = [m["role"] for m in request["messages"]]
    assert roles == ["user", "system"]
    assert request["messages"][-1]["content"] == "Soursop out of stock."
    # The system prompt, for its part, has not moved: its cache remains valid.
    assert request["system"] == assistant.build_request("something else")["system"]


def test_the_history_is_kept_as_is():
    history = [
        {"role": "user", "content": "<customer_message>\nHello\n</customer_message>"},
        {"role": "assistant", "content": "Hello! What can I do for you?"},
    ]
    request = assistant.build_request("The bissap?", history=history)
    assert request["messages"][:2] == history
    assert len(request["messages"]) == 3


def test_the_effort_comes_from_the_configuration(monkeypatch):
    monkeypatch.setattr("comptoir.config.EFFORT", "low")
    assert assistant.build_request("?")["output_config"] == {"effort": "low"}
    monkeypatch.setattr("comptoir.config.EFFORT", None)
    assert "output_config" not in assistant.build_request("?")


def test_the_log_records_the_prompt_version(tmp_path, monkeypatch):
    log = tmp_path / "calls.jsonl"
    monkeypatch.setattr("comptoir.config.LOG", str(log))
    text, _, _ = assistant.answer(FakeClient(), "How much is the syrup?")
    assert text == "The syrup costs 2,500 FCFA."
    line = json.loads(log.read_text(encoding="utf-8"))
    assert line["prompt"] == load("v1").id
