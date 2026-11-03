"""The Comptoir on the web, with a fake client: SSE stream, resumption, one answer at a time."""

import json
from datetime import datetime, timedelta, timezone

import anthropic
import httpx2
import pytest
from fastapi.testclient import TestClient

from comptoir.conversations import Conversations
from comptoir.errors import UNAVAILABLE
from comptoir.prompt import load, load_data
from comptoir.streaming import Generation
from comptoir.web import create_app
from fake_clients import FakeAsyncClient, FakeStream


@pytest.fixture(autouse=True)
def temporary_log(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.LOG", str(tmp_path / "calls.jsonl"))
    monkeypatch.setattr("comptoir.config.MODEL", "claude-sonnet-5-5")
    monkeypatch.setattr("comptoir.config.EFFORT", None)
    monkeypatch.setattr("comptoir.config.BUDGET_DB", ":memory:")  # never a file during the tests


def read_sse(body: str) -> list[tuple[str, dict]]:
    """Splits an SSE stream into (name, data). The comments (signs of life) are ignored."""
    events = []
    for block in body.split("\n\n"):
        name = next((l[7:] for l in block.splitlines() if l.startswith("event: ")), None)
        data = "".join(l[6:] for l in block.splitlines() if l.startswith("data: "))
        if name:
            events.append((name, json.loads(data)))
    return events


def send(http, text, message_id, conversation=None, since=0):
    r = http.post(
        "/api/messages",
        json={"conversation": conversation, "message_id": message_id, "text": text, "since": since},
    )
    return r, read_sse(r.text) if r.status_code == 200 else []


def test_the_page_is_displayed():
    with TestClient(create_app(FakeAsyncClient(), Conversations())) as http:
        r = http.get("/")
    assert r.status_code == 200 and "Awa's Comptoir" in r.text


def test_the_answer_arrives_in_chunks_then_is_stored():
    conversations = Conversations()
    client = FakeAsyncClient(FakeStream(["We have ", "bissap."]))
    with TestClient(create_app(client, conversations)) as http:
        r, events = send(http, "Your juices?", "message-0001")
    assert r.headers["content-type"].startswith("text/event-stream")
    assert [name for name, _ in events] == ["conversation", "text", "text", "end"]
    conversation = events[0][1]["conversation"]
    history = conversations.history(conversation)
    assert history[0] == {"role": "user", "content": "<customer_message>\nYour juices?\n</customer_message>"}
    # The answer is stored as is, thinking included.
    assert [b["type"] for b in history[1]["content"]] == ["thinking", "text"]


def test_the_next_turn_sends_back_the_history_without_rewriting_it():
    conversations = Conversations()
    client = FakeAsyncClient(FakeStream(["Yes, bissap."]), FakeStream(["Six bottles: 6,000 FCFA."]))
    with TestClient(create_app(client, conversations)) as http:
        _, events = send(http, "Do you have bissap?", "message-0001")
        conversation = events[0][1]["conversation"]
        send(http, "And for six bottles?", "message-0002", conversation)
    first, second = client.requests
    assert second["messages"][:1] == first["messages"]  # same beginning, to the character
    assert second["messages"][1]["role"] == "assistant"
    assert second["messages"][1]["content"][0]["signature"] == "test-signature"


def test_the_same_message_sent_again_after_a_cut_does_not_call_claude_twice():
    client = FakeAsyncClient(FakeStream(["We have ", "bissap", "."]))
    with TestClient(create_app(client, Conversations())) as http:
        _, first = send(http, "Your juices?", "message-0001")
        conversation = first[0][1]["conversation"]
        # The browser had received 2 chunks before the cut: it asks for the rest.
        _, resumed = send(http, "Your juices?", "message-0001", conversation, since=2)
    assert len(client.requests) == 1
    assert [d for name, d in resumed if name == "text"] == [{"text": "."}]
    assert resumed[-1][0] == "end"


def test_one_answer_at_a_time_per_conversation():
    conversations = Conversations()
    app = create_app(FakeAsyncClient(), conversations)
    conversation = conversations.create(load().id)
    app.state.comptoir.generations["message-in-progress"] = Generation(conversation)  # not finished yet
    with TestClient(app) as http:
        r, _ = send(http, "And the ginger?", "message-0002", conversation)
    assert r.status_code == 409


def test_an_expired_conversation_starts_from_zero(monkeypatch):
    conversations = Conversations()
    old = conversations.create(load().id)
    two_days_ago = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    conversations._db.execute("UPDATE conversations SET last_activity = ?", (two_days_ago,))
    client = FakeAsyncClient(FakeStream(["Hello!"]))
    with TestClient(create_app(client, conversations)) as http:
        _, events = send(http, "Hello", "message-0001", old)
    name, data = events[0]
    assert data["renewed"] == "expired" and data["conversation"] != old
    assert client.requests[0]["messages"][:-1] == []  # nothing from the old conversation


def test_a_modified_catalog_opens_a_new_conversation(monkeypatch):
    conversations = Conversations()
    client = FakeAsyncClient(FakeStream(["Bissap is 1,000 FCFA."]), FakeStream(["Bissap is 1,100 FCFA."]))
    with TestClient(create_app(client, conversations)) as http:
        _, first = send(http, "The price of bissap?", "message-0001")
        conversation = first[0][1]["conversation"]
        # Awa changes a price: the rendered system prompt changes, its fingerprint too.
        data = load_data()
        data["products"][0]["price_fcfa"] += 100
        monkeypatch.setattr("comptoir.prompt.load_data", lambda *a, **k: data)
        _, second = send(http, "And now?", "message-0002", conversation)
    assert second[0][1]["renewed"] == "new_prompt"
    assert second[0][1]["conversation"] != conversation
    # The old history, and its thinking blocks, are not sent back with the new prompt.
    assert len(client.requests[1]["messages"]) == 1


def test_an_error_is_told_to_the_customer_and_nothing_is_stored():
    conversations = Conversations()
    refusal = anthropic.BadRequestError(
        "Invalid request",
        response=httpx2.Response(400, request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages")),
        body=None,
    )
    client = FakeAsyncClient(FakeStream(["x"], cut_at=0, error=refusal))
    with TestClient(create_app(client, conversations)) as http:
        _, events = send(http, "Hello", "message-0001")
    assert events[-1] == ("error", {"type": "error", "message": UNAVAILABLE})
    assert conversations.history(events[0][1]["conversation"]) == []


def test_the_same_conversation_over_websocket():
    client = FakeAsyncClient(FakeStream(["We deliver ", "in Cotonou."]))
    with TestClient(create_app(client, Conversations())) as http, http.websocket_connect("/ws") as ws:
        ws.send_json({"message_id": "message-0001", "text": "Do you deliver to Akpakpa?"})
        received = [ws.receive_json() for _ in range(4)]
    assert [e["type"] for e in received] == ["conversation", "text", "text", "end"]
    assert "".join(e["text"] for e in received if e["type"] == "text") == "We deliver in Cotonou."


# --- Chapter 8: budget, refusals, errors ---------------------------------------------------


def test_over_budget_the_customer_is_told_and_claude_is_not_called(monkeypatch, tmp_path):
    from comptoir.budget import Budget

    monkeypatch.setattr("comptoir.config.CUSTOMER_DAILY_QUOTA", 0.0001)
    client = FakeAsyncClient(FakeStream(["Hello!"]))
    with TestClient(create_app(client, Conversations(), Budget())) as http:
        _, events = send(http, "Hello", "message-0001")
    assert events[-1] == ("error", {"type": "error", "message": UNAVAILABLE})
    assert client.requests == []  # the counting took place, not the call


def test_a_refusal_erases_the_beginning_and_does_not_enter_the_history():
    from comptoir.errors import REFUSAL
    from fake_clients import final_message

    conversations = Conversations()
    refusal = FakeStream(["I will "], message=final_message("I will ", stop_reason="refusal"))
    with TestClient(create_app(FakeAsyncClient(refusal), conversations)) as http:
        _, events = send(http, "A refused request", "message-0001")
    assert events[-1] == ("refusal", {"type": "refusal", "message": REFUSAL})
    assert conversations.history(events[0][1]["conversation"]) == []


def test_an_api_error_before_any_text_releases_the_budget():
    from comptoir.budget import Budget

    budget = Budget()
    refusal = anthropic.BadRequestError(
        "Invalid request",
        response=httpx2.Response(400, request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages")),
        body=None,
    )
    with TestClient(create_app(FakeAsyncClient(FakeStream(["x"], cut_at=0, error=refusal)), Conversations(), budget)) as http:
        send(http, "Hello", "message-0001")
    assert budget.for_day() == 0
