"""The Comptoir's conversations, kept by the application (chapter 6).

The API keeps nothing: this is where the history lives. It is append-only: messages
are added, a past message of an open conversation is never modified or deleted.
The blocks returned by Claude, thinking included, are kept as they are.
"""

import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from comptoir import config


def _now() -> datetime:
    return datetime.now(timezone.utc)


def to_blocks(content) -> str | list[dict]:
    """The content of a message, in a form that is stored as JSON and sent back to the API.

    exclude_none: a plain model_dump() would add empty fields (citations: null…)
    which the API refuses when they are sent back to it.
    """
    if isinstance(content, str):
        return content
    return [b if isinstance(b, dict) else b.model_dump(mode="json", exclude_none=True) for b in content]


class Conversations:
    def __init__(self, path: str = ":memory:"):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                last_activity TEXT NOT NULL,
                tokens INTEGER NOT NULL DEFAULT 0,
                prompt TEXT);
            CREATE TABLE IF NOT EXISTS messages (
                conversation TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                PRIMARY KEY (conversation, position));
            PRAGMA foreign_keys = ON;
            """
        )

    def create(self, prompt: str | None = None) -> str:
        """prompt: the ID of the system prompt (version and fingerprint) that opens the conversation."""
        conversation_id = uuid.uuid4().hex
        date = _now().isoformat()
        with self._db:
            self._db.execute("INSERT INTO conversations VALUES (?, ?, ?, 0, ?)", (conversation_id, date, date, prompt))
        return conversation_id

    def exists(self, conversation_id: str) -> bool:
        return self._db.execute("SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)).fetchone() is not None

    def history(self, conversation_id: str) -> list[dict]:
        rows = self._db.execute(
            "SELECT role, content FROM messages WHERE conversation = ? ORDER BY position", (conversation_id,)
        ).fetchall()
        return [{"role": role, "content": json.loads(content)} for role, content in rows]

    def add_turn(self, conversation_id: str, messages: list[dict], tokens: int) -> None:
        """Adds a complete turn (the customer's message, Claude's answer) in a single transaction.

        A question is never recorded without its answer: if the call fails, nothing is
        written, and the history stays as Claude last saw it.
        tokens: the size of the context after this turn (input, cache included, plus the output).
        """
        with self._db:
            (position,) = self._db.execute(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM messages WHERE conversation = ?", (conversation_id,)
            ).fetchone()
            for offset, message in enumerate(messages):
                self._db.execute(
                    "INSERT INTO messages VALUES (?, ?, ?, ?)",
                    (
                        conversation_id,
                        position + offset,
                        message["role"],
                        json.dumps(to_blocks(message["content"]), ensure_ascii=False),
                    ),
                )
            self._db.execute(
                "UPDATE conversations SET last_activity = ?, tokens = ? WHERE id = ?",
                (_now().isoformat(), tokens, conversation_id),
            )

    def closing_reason(
        self, conversation_id: str, prompt: str | None = None, now: datetime | None = None
    ) -> str | None:
        """“new_prompt”, “expired”, “too_long”, or None if the conversation can continue.

        A modified system prompt invalidates the thinking blocks already in the history:
        the next request would be refused (400 error). The conversation is therefore closed
        when today's prompt is no longer the one that opened it.
        """
        last, tokens, initial_prompt = self._db.execute(
            "SELECT last_activity, tokens, prompt FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
        if prompt is not None and prompt != initial_prompt:
            return "new_prompt"
        if (now or _now()) - datetime.fromisoformat(last) > timedelta(hours=config.EXPIRY_H):
            return "expired"
        if tokens > config.MAX_CONTEXT:
            return "too_long"
        return None

    def erase(self, conversation_id: str) -> bool:
        """At the customer's request (chapter 18): the conversation and all its messages, right away."""
        with self._db:
            return self._db.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,)).rowcount == 1

    def purge(self, now: datetime | None = None) -> int:
        """Deletes the conversations with no activity for RETENTION_DAYS days. Returns their number."""
        limit = (now or _now()) - timedelta(days=config.RETENTION_DAYS)
        with self._db:
            cursor = self._db.execute("DELETE FROM conversations WHERE last_activity < ?", (limit.isoformat(),))
        return cursor.rowcount
