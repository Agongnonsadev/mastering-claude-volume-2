"""Awa's shop as the code sees it: stock, summaries, orders, requests (chapter 9).

This is where, and not in the model, the rules that commit money live: the prices,
the delivery fee, the stock, and above all the creation of an order. Claude prepares a
summary; only the customer, with a confirmation code that the code checks,
turns it into an order. And an order is created only once.
"""

import json
import random
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from comptoir.guard import name_problem, neighborhood_problem
from comptoir.prompt import FOLDER, load_data

COTONOU = timezone(timedelta(hours=1))  # Benin is at UTC+1, with no daylight saving time
DELIVERY_FEE = 500                      # FCFA, below the threshold (Awa's terms)
FREE_DELIVERY_THRESHOLD = 5             # bottles
MAXIMUM_WITHOUT_QUOTE = 50              # bottles: beyond that, Awa makes a quote
SUMMARY_VALIDITY = timedelta(hours=2)


class ShopRefusal(Exception):
    """A request the shop refuses, with a message that says what to do."""


def initial(name: str) -> str:
    """“Larissa Noudéhou” -> “Larissa N.”: enough for a past order, without the full name."""
    parts = name.split()
    return name if len(parts) < 2 else f"{parts[0]} {parts[-1][0]}."


@dataclass(frozen=True)
class Line:
    product: str
    quantity: int
    unit_price: int

    @property
    def amount(self) -> int:
        return self.quantity * self.unit_price


class Shop:
    def __init__(self, path: str = ":memory:", data: dict | None = None, stock: dict | None = None,
                 clock=None, rng: random.Random | None = None):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._rng = rng or random.SystemRandom()
        self.catalog = {p["name"]: p for p in (data or load_data())["products"]}
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS stock (product TEXT PRIMARY KEY, quantity INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS summaries (
                id TEXT PRIMARY KEY, conversation TEXT NOT NULL, code TEXT NOT NULL, lines TEXT NOT NULL,
                customer_name TEXT NOT NULL, neighborhood TEXT NOT NULL, delivery_fee INTEGER NOT NULL,
                total INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY, summary TEXT NOT NULL UNIQUE, conversation TEXT NOT NULL,
                total INTEGER NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS requests (
                id TEXT PRIMARY KEY, conversation TEXT NOT NULL, reason TEXT NOT NULL, summary TEXT NOT NULL,
                created_at TEXT NOT NULL);
            """
        )
        if stock is None and not self._db.execute("SELECT 1 FROM stock").fetchone():
            stock = json.loads((FOLDER / "data" / "initial_stock.json").read_text(encoding="utf-8"))["stock"]
        if stock is not None:
            with self._db:
                self._db.executemany("INSERT OR REPLACE INTO stock VALUES (?, ?)", stock.items())

    def _now(self) -> datetime:
        return self._clock()

    # --- Read --------------------------------------------------------------------------

    def available(self, product: str) -> int | None:
        """The quantity in stock, or None if the product is not in the catalog."""
        if product not in self.catalog:
            return None
        row = self._db.execute("SELECT quantity FROM stock WHERE product = ?", (product,)).fetchone()
        return row[0] if row else 0

    def _is_a_bottle(self, product: str) -> bool:
        # The juices come in 500 ml bottles; a bottle of syrup does not count toward free delivery.
        return self.catalog[product]["format"].endswith("ml bottle")

    def planned_delivery(self, instant: datetime) -> str:
        """The same day for an order placed before 12 p.m. (Cotonou time), otherwise the next day."""
        local = instant.astimezone(COTONOU)
        return "today" if local.hour < 12 else "tomorrow"

    # --- Prepare a summary (what Claude can do) ---------------------------

    def prepare(self, conversation: str, lines: list[dict], customer_name: str, neighborhood: str) -> dict:
        if not lines:
            raise ShopRefusal("The order is empty: ask the customer what they would like.")
        # Chapter 18: the name and the neighborhood end up in Awa's Claude application. Short data,
        # nothing else: the rest of the customer's message has nothing to do in the shop.
        for problem in (name_problem(customer_name), neighborhood_problem(neighborhood)):
            if problem:
                raise ShopRefusal(
                    f"Summary refused: {problem}. Give only the name given for delivery and the name "
                    "of the neighborhood, without an address, without comment or instruction; ask the customer for them if needed."
                )
        customer_name, neighborhood = customer_name.strip(), neighborhood.strip()
        kept: list[Line] = []
        for line in lines:
            product, quantity = line["product"], line["quantity"]
            if product not in self.catalog:
                raise ShopRefusal(
                    f"Product “{product}” missing from the catalog. Available products: "
                    f"{', '.join(self.catalog)}. Offer the customer to choose among them."
                )
            if quantity < 1:
                raise ShopRefusal(f"Quantity {quantity} invalid for {product}: at least 1 is needed.")
            stock = self.available(product)
            if quantity > stock:
                raise ShopRefusal(
                    f"Insufficient stock: {stock} available for {product}, {quantity} requested. "
                    "Offer a possible quantity or another product; prepare nothing without the customer's consent."
                )
            kept.append(Line(product, quantity, self.catalog[product]["price_fcfa"]))

        bottles = sum(l.quantity for l in kept if self._is_a_bottle(l.product))
        if bottles > MAXIMUM_WITHOUT_QUOTE:
            raise ShopRefusal(
                f"{bottles} bottles: beyond {MAXIMUM_WITHOUT_QUOTE}, the price is on quote. "
                "Use pass_to_awa with the reason quote."
            )
        fee = 0 if bottles >= FREE_DELIVERY_THRESHOLD else DELIVERY_FEE
        total = sum(l.amount for l in kept) + fee
        now = self._now()
        code = f"{self._rng.randrange(10_000):04d}"
        summary_id = uuid.uuid4().hex
        with self._db:
            # A new summary cancels the previous one of the same conversation: the customer
            # changed their mind, and the old code must no longer create anything.
            self._db.execute(
                "UPDATE summaries SET status = 'replaced' WHERE conversation = ? AND status = 'pending'",
                (conversation,),
            )
            self._db.execute(
                "INSERT INTO summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
                (summary_id, conversation, code, json.dumps([l.__dict__ for l in kept], ensure_ascii=False),
                 customer_name, neighborhood, fee, total, now.isoformat()),
            )
        return {
            "summary": summary_id[:8],
            "lines": [{"product": l.product, "quantity": l.quantity, "unit_price": l.unit_price,
                       "amount": l.amount} for l in kept],
            "delivery_fee": fee,
            "total_fcfa": total,
            "planned_delivery": self.planned_delivery(now),
            "customer_name": customer_name,
            "neighborhood": neighborhood,
            "confirmation_code": code,
            "to_tell_the_customer": f"To confirm, the customer replies exactly: YES {code}",
        }

    # --- Confirm (what only the customer can do, with their code) ---------------------

    def confirm(self, conversation: str, code: str) -> dict:
        """Creates the order, only once. Calling again with the same code returns the same order."""
        with self._db:
            summary = self._db.execute(
                "SELECT id, lines, total, status, created_at FROM summaries WHERE conversation = ? AND code = ? "
                "ORDER BY created_at DESC LIMIT 1",
                (conversation, code),
            ).fetchone()
            if summary is None:
                raise ShopRefusal("This code matches no summary of this conversation.")
            summary_id, lines, total, status, created_at = summary
            if status == "confirmed":
                (number,) = self._db.execute("SELECT id FROM orders WHERE summary = ?", (summary_id,)).fetchone()
                return {"order": number, "total_fcfa": total, "already_recorded": True}
            if status == "replaced":
                raise ShopRefusal("This summary has been replaced by a more recent one: use the last code received.")
            if self._now() - datetime.fromisoformat(created_at) > SUMMARY_VALIDITY:
                raise ShopRefusal("This summary has expired: ask for a new one.")
            # The stock may have changed since the summary: it is checked again at the moment of creating.
            for line in json.loads(lines):
                if line["quantity"] > self.available(line["product"]):
                    raise ShopRefusal(f"The stock of {line['product']} has changed: ask for a new summary.")
            for line in json.loads(lines):
                self._db.execute("UPDATE stock SET quantity = quantity - ? WHERE product = ?",
                                 (line["quantity"], line["product"]))
            (rank,) = self._db.execute("SELECT COUNT(*) + 1 FROM orders").fetchone()
            number = f"C-{rank:04d}"
            # The UNIQUE constraint on the summary forbids, as a last resort, any double order.
            self._db.execute("INSERT INTO orders VALUES (?, ?, ?, ?, ?)",
                             (number, summary_id, conversation, total, self._now().isoformat()))
            self._db.execute("UPDATE summaries SET status = 'confirmed' WHERE id = ?", (summary_id,))
        return {"order": number, "total_fcfa": total, "already_recorded": False}

    # --- Pass on to Awa --------------------------------------------------------------

    def pass_on(self, conversation: str, reason: str, summary: str) -> dict:
        request_id = f"D-{uuid.uuid4().hex[:6]}"
        with self._db:
            self._db.execute("INSERT INTO requests VALUES (?, ?, ?, ?, ?)",
                             (request_id, conversation, reason, summary, self._now().isoformat()))
        return {"request": request_id, "passed_on": True}

    # --- Keep only what is necessary (chapter 18) --------------------------------------

    def purge(self, request_days: int, name_days: int, summary_days: int, now: datetime | None = None) -> dict:
        """Applies Awa's retention periods. Returns what was erased or reduced."""
        instant = now or self._now()

        def before(days: int) -> str:
            return (instant - timedelta(days=days)).isoformat()

        with self._db:
            requests = self._db.execute("DELETE FROM requests WHERE created_at < ?", (before(request_days),)).rowcount
            summaries = self._db.execute("DELETE FROM summaries WHERE status != 'confirmed' AND created_at < ?",
                                         (before(summary_days),)).rowcount
            names = 0
            for summary_id, name in self._db.execute(
                    "SELECT id, customer_name FROM summaries WHERE status = 'confirmed' AND created_at < ?",
                    (before(name_days),)).fetchall():
                if initial(name) != name:
                    self._db.execute("UPDATE summaries SET customer_name = ? WHERE id = ?", (initial(name), summary_id))
                    names += 1
        return {"requests_erased": requests, "summaries_erased": summaries, "names_reduced": names}

    def erase(self, conversation: str) -> dict:
        """At a customer's request: everything that comes from their conversation, except what the accounts require.
        Their orders stay (products, total, date, neighborhood), under their first name and initial only."""
        with self._db:
            requests = self._db.execute("DELETE FROM requests WHERE conversation = ?", (conversation,)).rowcount
            summaries = self._db.execute("DELETE FROM summaries WHERE conversation = ? AND status != 'confirmed'",
                                         (conversation,)).rowcount
            for summary_id, name in self._db.execute(
                    "SELECT id, customer_name FROM summaries WHERE conversation = ?", (conversation,)).fetchall():
                self._db.execute("UPDATE summaries SET customer_name = ? WHERE id = ?", (initial(name), summary_id))
        return {"requests_erased": requests, "summaries_erased": summaries}

    # --- For the tests and the dashboard ------------------------------------------

    def orders(self) -> list[tuple]:
        return self._db.execute("SELECT id, summary, conversation, total FROM orders").fetchall()

    def requests(self) -> list[tuple]:
        return self._db.execute("SELECT id, conversation, reason, summary FROM requests").fetchall()

    def summaries(self, conversation: str) -> list[tuple]:
        return self._db.execute(
            "SELECT code, status, total, lines FROM summaries WHERE conversation = ? ORDER BY created_at",
            (conversation,),
        ).fetchall()
