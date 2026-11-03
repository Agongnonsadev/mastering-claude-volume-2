"""The history of conversations: append-only, blocks kept as they are, closing and purge."""

from datetime import datetime, timedelta, timezone

from anthropic.types import TextBlock, ThinkingBlock

from comptoir.conversations import Conversations

QUESTION = {"role": "user", "content": "<customer_message>\nHello\n</customer_message>"}
ANSWER = {
    "role": "assistant",
    "content": [
        ThinkingBlock(type="thinking", thinking="", signature="sig-1"),
        TextBlock(type="text", text="Hello! What can I do for you?"),
    ],
}


def test_claudes_blocks_are_kept_as_they_are():
    conversations = Conversations()
    c = conversations.create()
    conversations.add_turn(c, [QUESTION, ANSWER], tokens=1200)
    history = conversations.history(c)
    assert history[0] == QUESTION
    # The thinking and its signature are there, and no empty field (citations: null) has been added.
    assert history[1]["content"] == [
        {"type": "thinking", "thinking": "", "signature": "sig-1"},
        {"type": "text", "text": "Hello! What can I do for you?"},
    ]


def test_the_history_only_grows():
    conversations = Conversations()
    c = conversations.create()
    conversations.add_turn(c, [QUESTION, ANSWER], tokens=1200)
    before = conversations.history(c)
    conversations.add_turn(c, [QUESTION, {"role": "assistant", "content": "With pleasure."}], tokens=1500)
    after = conversations.history(c)
    # The beginning is identical, to the character: the cache and the preserved thinking remain valid.
    assert after[: len(before)] == before
    assert [m["role"] for m in after] == ["user", "assistant", "user", "assistant"]


def test_a_conversation_closes_after_24_hours_or_when_it_is_too_long(monkeypatch):
    monkeypatch.setattr("comptoir.config.EXPIRY_H", 24)
    monkeypatch.setattr("comptoir.config.MAX_CONTEXT", 40_000)
    conversations = Conversations()
    c = conversations.create()
    conversations.add_turn(c, [QUESTION, ANSWER], tokens=1200)
    now = datetime.now(timezone.utc)
    assert conversations.closing_reason(c, now=now) is None
    assert conversations.closing_reason(c, now=now + timedelta(hours=25)) == "expired"
    conversations.add_turn(c, [QUESTION, ANSWER], tokens=41_000)
    assert conversations.closing_reason(c, now=now) == "too_long"


def test_a_new_prompt_closes_the_conversation():
    conversations = Conversations()
    c = conversations.create(prompt="system-v1@aaaa1111")
    assert conversations.closing_reason(c, prompt="system-v1@aaaa1111") is None
    # Awa changed a price: the rendered prompt changes fingerprint, the conversation is closed.
    assert conversations.closing_reason(c, prompt="system-v1@bbbb2222") == "new_prompt"


def test_the_purge_deletes_old_conversations_and_their_messages(monkeypatch):
    monkeypatch.setattr("comptoir.config.RETENTION_DAYS", 30)
    conversations = Conversations()
    c = conversations.create()
    conversations.add_turn(c, [QUESTION, ANSWER], tokens=1200)
    assert conversations.purge(datetime.now(timezone.utc) + timedelta(days=29)) == 0
    assert conversations.purge(datetime.now(timezone.utc) + timedelta(days=31)) == 1
    assert not conversations.exists(c)
    assert conversations.history(c) == []
