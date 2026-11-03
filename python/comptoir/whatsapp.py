"""The Comptoir on WhatsApp (chapter 19): Meta's Cloud API, according to its documentation of October 22, 2026.

- Webhook verification: Meta sends a GET with hub.mode=subscribe, hub.verify_token and
  hub.challenge; hub.challenge is returned, status 200, if the token is the right one.
- Signature: each notification carries X-Hub-Signature-256, “sha256=” followed by the HMAC-SHA256 of the body,
  calculated with the app secret. A notification badly signed is refused.
- Incoming messages: entry[].changes[].value.messages[], with from (the number), id (wamid…), type, text.body;
  metadata.phone_number_id says which of the business's numbers to answer from. The statuses (sent, read) are ignored.
- Duplicates: Meta retries for 7 days a notification that did not get a 200, and can send it
  twice; each message is handled only once (the directory's already-seen table).
- Answer: POST https://graph.facebook.com/<version>/<phone_number_id>/messages, a text of 4,096
  characters at most, only in the 24-hour customer service window opened by the customer.

A customer's number is personal data: it does not leave the directory (Directory), neither for the
log, nor for the budget. Elsewhere, its fingerprint is written (pseudonym).
"""

import hashlib
import hmac
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx2

GRAPH = "https://graph.facebook.com"
MAX_LENGTH = 4096
# Anthropic's usage policy: tell the customer they are talking to an AI, at the start of each
# conversation. On the web, the page says it; on WhatsApp, it is the first message, written by the code.
AI_DISCLOSURE = ("Hello, I'm the Comptoir, the automated assistant of Délices d'Awa: an artificial "
                 "intelligence, not a person. To talk to Awa, just ask.")
NOT_TEXT = "I can only read written messages for now: could you write your request to me?"


def valid_signature(body: bytes, header: str | None, secret: str) -> bool:
    if not secret or not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header.removeprefix("sha256="))


def pseudonym(number: str, salt: str) -> str:
    """A stable fingerprint of the number: enough to count and limit, without writing the number. Without a salt, it
    protects nothing (all the possible numbers can be tried): refused (chapter 20)."""
    if not salt:
        raise ValueError("The salt of the fingerprints (COMPTOIR_PSEUDONYM_SALT) is empty.")
    return "wa-" + hmac.new(salt.encode("utf-8"), number.encode("utf-8"), hashlib.sha256).hexdigest()[:16]


@dataclass(frozen=True)
class IncomingMessage:
    id: str                 # wamid…, unique: the key against duplicates
    number: str             # the customer's WhatsApp number (from)
    business_number: str    # metadata.phone_number_id: Awa's number that received the message
    type: str               # text, image, audio…
    text: str | None
    timestamp: int


def incoming_messages(notification: dict) -> list[IncomingMessage]:
    output = []
    for entry in notification.get("entry", []):
        for change in entry.get("changes", []):
            if change.get("field") != "messages":
                continue
            value = change.get("value", {})
            business_number = value.get("metadata", {}).get("phone_number_id", "")
            for m in value.get("messages", []):
                output.append(IncomingMessage(m.get("id", ""), m.get("from", ""), business_number, m.get("type", ""),
                                              (m.get("text") or {}).get("body"), int(m.get("timestamp") or 0)))
    return output


def split(text: str, length: int = MAX_LENGTH) -> list[str]:
    """A text too long for a single message, cut between two paragraphs when possible."""
    parts = []
    while len(text) > length:
        cut = text.rfind("\n", 0, length)
        cut = cut if cut > length // 2 else length
        parts.append(text[:cut].rstrip())
        text = text[cut:].lstrip()
    return [*parts, text] if text else parts


class Sender:
    """Sends the answers through the Graph API, with a system user's token (never in the code)."""

    def __init__(self, token: str, version: str = "v26.0", http_client=None):
        self.token, self.version = token, version
        self.http = http_client or httpx2.Client(timeout=30)

    def send(self, business_number: str, number: str, text: str) -> list[str]:
        """Returns the IDs of the messages sent; raises an HTTP error if Meta refuses."""
        ids = []
        for part in split(text):
            r = self.http.post(f"{GRAPH}/{self.version}/{business_number}/messages",
                               headers={"Authorization": f"Bearer {self.token}"},
                               json={"messaging_product": "whatsapp", "recipient_type": "individual",
                                     "to": number, "type": "text", "text": {"body": part}})
            r.raise_for_status()
            ids += [m.get("id") for m in r.json().get("messages", [])]
        return ids


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Directory:
    """For each WhatsApp customer: their fingerprint, their number (to answer them), their current conversation.
    In the same database as the conversations, and purged with them: it is the only place of the number.
    Also keeps the messages already handled, against Meta's duplicates."""

    def __init__(self, path: str = ":memory:"):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS whatsapp_customers (
                pseudonym TEXT PRIMARY KEY, number TEXT NOT NULL, conversation TEXT NOT NULL, seen_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS whatsapp_already_seen (id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
            """
        )

    def new(self, message_id: str) -> bool:
        """True the first time this message is seen; false for a duplicate."""
        with self._db:
            return self._db.execute("INSERT OR IGNORE INTO whatsapp_already_seen VALUES (?, ?)",
                                    (message_id, _now().isoformat())).rowcount == 1

    def conversation(self, pseudo: str) -> str | None:
        row = self._db.execute("SELECT conversation FROM whatsapp_customers WHERE pseudonym = ?", (pseudo,)).fetchone()
        return row[0] if row else None

    def link(self, pseudo: str, number: str, conversation: str) -> None:
        with self._db:
            self._db.execute("INSERT OR REPLACE INTO whatsapp_customers VALUES (?, ?, ?, ?)",
                             (pseudo, number, conversation, _now().isoformat()))

    def erase(self, conversation: str) -> int:
        """The number linked to a conversation that a customer asked to erase (chapter 21: the erasure
        command of chapter 18 forgot the directory, where the number remained)."""
        with self._db:
            return self._db.execute("DELETE FROM whatsapp_customers WHERE conversation = ?", (conversation,)).rowcount

    def purge(self, days: int, now: datetime | None = None) -> int:
        """Forgets the customers without a message for `days` days, and the duplicates older than 8 days
        (Meta retries only for 7 days)."""
        instant = now or _now()
        with self._db:
            customers = self._db.execute("DELETE FROM whatsapp_customers WHERE seen_at < ?",
                                         ((instant - timedelta(days=days)).isoformat(),)).rowcount
            self._db.execute("DELETE FROM whatsapp_already_seen WHERE received_at < ?",
                             ((instant - timedelta(days=8)).isoformat(),))
        return customers
