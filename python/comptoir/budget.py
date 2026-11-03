"""The Comptoir's budget: ceilings per customer, per day and per month, checked before each call (chapter 8).

The principle is that of Studio Botlyx's daily ceiling: check before running, counting
what is already in progress. Each call first reserves its maximum possible cost
(known input, output at most max_tokens), then settles its real cost once finished.
Ten calls started at the same time therefore cannot exceed the ceiling between the ten of them.

Days and months are counted in universal time (UTC), like Anthropic's monthly
ceiling, which restarts on the 1st at 00:00 UTC.
"""

import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from comptoir import config


@dataclass(frozen=True)
class Decision:
    accepted: bool
    reservation: str | None = None
    reason: str | None = None   # customer_quota, daily_budget, monthly_budget
    alert: bool = False         # the alert threshold of the day or the month is crossed


class Budget:
    def __init__(self, path: str = ":memory:", clock=None):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS expenses (
                id TEXT PRIMARY KEY, day TEXT NOT NULL, month TEXT NOT NULL,
                customer TEXT NOT NULL, dollars REAL NOT NULL, settled INTEGER NOT NULL, group_id TEXT)"""
        )
        # Chapter 18: the group_id column (the customer's network address), added to databases already created.
        if "group_id" not in {row[1] for row in self._db.execute("PRAGMA table_info(expenses)")}:
            self._db.execute("ALTER TABLE expenses ADD COLUMN group_id TEXT")
        self._db.commit()

    def _now(self) -> tuple[str, str]:
        instant = self._clock()
        return instant.strftime("%Y-%m-%d"), instant.strftime("%Y-%m")

    def _sum(self, condition: str, value: str) -> float:
        (total,) = self._db.execute(f"SELECT COALESCE(SUM(dollars), 0) FROM expenses WHERE {condition} = ?", (value,)).fetchone()
        return total

    def for_day(self) -> float:
        return self._sum("day", self._now()[0])

    def for_month(self) -> float:
        return self._sum("month", self._now()[1])

    def for_customer(self, customer_id: str) -> float:
        day, _ = self._now()
        (total,) = self._db.execute(
            "SELECT COALESCE(SUM(dollars), 0) FROM expenses WHERE day = ? AND customer = ?", (day, customer_id)
        ).fetchone()
        return total

    def for_group(self, group: str) -> float:
        day, _ = self._now()
        (total,) = self._db.execute(
            "SELECT COALESCE(SUM(dollars), 0) FROM expenses WHERE day = ? AND group_id = ?", (day, group)
        ).fetchone()
        return total

    def reserve(self, customer_id: str, maximum: float, group: str | None = None) -> Decision:
        """Reserves the maximum cost of a call, if it fits within the ceilings.

        group (chapter 18): what links several conversations, the network address on the web. A
        new conversation at each message does not reset this counter to zero."""
        day, month = self._now()
        ceilings = [("customer_quota", self.for_customer(customer_id), config.CUSTOMER_DAILY_QUOTA)]
        if group:
            ceilings.append(("network_quota", self.for_group(group), config.NETWORK_DAILY_QUOTA))
        ceilings += [("daily_budget", self.for_day(), config.DAILY_BUDGET),
                     ("monthly_budget", self.for_month(), config.MONTHLY_BUDGET)]
        with self._db:  # check and reserve in the same transaction
            for reason, spent, ceiling in ceilings:
                if spent + maximum > ceiling:
                    return Decision(False, reason=reason, alert=True)
            reservation = uuid.uuid4().hex
            self._db.execute(
                "INSERT INTO expenses (id, day, month, customer, dollars, settled, group_id) VALUES (?, ?, ?, ?, ?, 0, ?)",
                (reservation, day, month, customer_id, maximum, group),
            )
        return Decision(True, reservation, alert=self.on_alert())

    def settle(self, reservation: str, dollars: float) -> None:
        """Replaces the reservation with the real cost of the call."""
        with self._db:
            self._db.execute("UPDATE expenses SET dollars = ?, settled = 1 WHERE id = ?", (dollars, reservation))

    def add(self, customer_id: str, dollars: float, group: str | None = None) -> None:
        """Counts an expense already made, with no ceiling to check: the call has taken place (chapter 20,
        the monitoring, which runs alongside the answer and reserves nothing beforehand)."""
        day, month = self._now()
        with self._db:
            self._db.execute(
                "INSERT INTO expenses (id, day, month, customer, dollars, settled, group_id) VALUES (?, ?, ?, ?, ?, 1, ?)",
                (uuid.uuid4().hex, day, month, customer_id, dollars, group),
            )

    def release(self, reservation: str) -> None:
        """Cancels a reservation: the call cost nothing (refused by the API before any processing)."""
        with self._db:
            self._db.execute("DELETE FROM expenses WHERE id = ?", (reservation,))

    def on_alert(self) -> bool:
        return self.for_day() >= config.ALERT_THRESHOLD * config.DAILY_BUDGET or (
            self.for_month() >= config.ALERT_THRESHOLD * config.MONTHLY_BUDGET
        )
