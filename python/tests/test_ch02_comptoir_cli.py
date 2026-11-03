"""The Comptoir on the command line, tested with a fake client: no paid call."""

import json
from types import SimpleNamespace

from anthropic.types import OutputTokensDetails, Usage

from ch02 import comptoir_cli


class FakeClient:
    """Imitates client.messages.create and keeps the last request to inspect it."""

    def __init__(self, message):
        self.last_request = None
        self._message = message
        self.messages = self

    def create(self, **request):
        self.last_request = request
        return self._message


def fake_message():
    return SimpleNamespace(
        content=[
            SimpleNamespace(type="thinking", thinking=""),  # thinking hidden by default
            SimpleNamespace(type="text", text="Ginger syrup costs 2,500 FCFA a bottle."),
        ],
        stop_reason="end_turn",
        usage=Usage(
            input_tokens=420,
            output_tokens=80,
            output_tokens_details=OutputTokensDetails(thinking_tokens=30),
        ),
        _request_id="req_test_0001",
    )


def test_answers_and_ignores_the_thinking_blocks(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.LOG", str(tmp_path / "calls.jsonl"))
    client = FakeClient(fake_message())

    text, price, _ = comptoir_cli.answer(client, "How much is the ginger syrup?", "claude-sonnet-5-5")

    assert text == "Ginger syrup costs 2,500 FCFA a bottle."
    assert price.thinking == 30
    assert price.dollars == (420 * 2 + 80 * 10) / 1_000_000


def test_sends_the_system_prompt_and_the_question(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.LOG", str(tmp_path / "calls.jsonl"))
    client = FakeClient(fake_message())

    comptoir_cli.answer(client, "Do you deliver to Calavi?", "claude-sonnet-5-5")

    request = client.last_request
    assert request["model"] == "claude-sonnet-5-5"
    assert "Délices d'Awa" in request["system"]
    assert request["messages"] == [{"role": "user", "content": "Do you deliver to Calavi?"}]
    assert "temperature" not in request  # refused by current models


def test_the_log_contains_neither_key_nor_message(tmp_path, monkeypatch):
    log = tmp_path / "calls.jsonl"
    monkeypatch.setattr("comptoir.config.LOG", str(log))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key")

    comptoir_cli.answer(FakeClient(fake_message()), "My number is 0197000000", "claude-sonnet-5-5")

    content = log.read_text(encoding="utf-8")
    line = json.loads(content)
    assert line["request"] == "req_test_0001"
    assert line["input_tokens"] == 420
    assert "sk-ant" not in content
    assert "0197000000" not in content
