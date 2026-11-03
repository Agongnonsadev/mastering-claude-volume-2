"""Chapter 14: makes the fictional history of Awa's orders, then the copy that Yao explores.

Run, from the python/ folder:  python -m ch14.make_orders
No call to the API. The draw is fixed: the figures are the same at each run
(only the internal IDs, drawn by uuid, change).

1. customer_data/shop_demo.sqlite3: the database of the chapter 9 shop, as in
   production. Thirteen weeks of summaries, orders and requests, from Monday
   July 20 to Sunday October 18, 2026, created by the shop's own code
   (Shop.prepare, Shop.confirm, Shop.pass_on) with a simulated clock.
2. customer_data/orders_exploration.sqlite3: the copy that Yao entrusts to Claude. The
   customers' names and the conversation numbers are replaced with pseudonyms, and the
   confirmation codes erased: Claude needs none of the three to count sales.
"""

import json
import random
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

from comptoir.shop import COTONOU, MAXIMUM_WITHOUT_QUOTE, Shop, ShopRefusal

ROOT = Path(__file__).parents[1]
DATABASE = ROOT / "customer_data" / "shop_demo.sqlite3"
COPY = ROOT / "customer_data" / "orders_exploration.sqlite3"
START = date(2026, 7, 20)                 # a Monday
END = date(2026, 10, 18)                  # a Sunday: thirteen weeks
SOURSOP_SHORTAGE = date(2026, 10, 3)      # the same shortage as in chapter 13
SEED = 14

# The weight of each product in the customers' requests.
PRODUCTS = {"Bissap juice": 40, "Ginger juice": 24, "Pineapple juice": 15, "Soursop juice": 11,
            "Bissap syrup": 6, "Ginger syrup": 4}
# The lines of a summary are drawn in this order: the alphabetical order of the French names, so
# that the same seed gives the same orders as in the French edition (and the figures of the book).
LINE_ORDER = ["Pineapple juice", "Bissap juice", "Soursop juice", "Ginger juice", "Bissap syrup", "Ginger syrup"]
# The neighborhoods delivered, with their weight. Real places of Cotonou and its surroundings; fictional customers.
NEIGHBORHOODS = {"Fidjrossè": 16, "Akpakpa": 14, "Cadjèhoun": 12, "Gbégamey": 10, "Haie Vive": 9, "Zogbo": 8,
                 "Agla": 8, "Godomey": 8, "Cocotiers": 7, "Abomey-Calavi": 8}
# Summaries prepared per day, from Monday to Sunday (averages before the draw).
PER_DAY = [7, 6, 7, 8, 10, 14, 4]
FIRST_NAMES = ["Adjoua", "Afi", "Akossiwa", "Aminata", "Bénédicte", "Bernadette", "Chantal", "Christelle", "Edwige",
               "Élodie", "Fifamè", "Gisèle", "Grâce", "Huguette", "Ida", "Jocelyne", "Larissa", "Mariam", "Nadège",
               "Odile", "Prisca", "Rachida", "Sandrine", "Sènami", "Yasmine", "Abdou", "Arnaud", "Basile", "Brice",
               "Carlos", "Cyrille", "Dossou", "Éric", "Fiacre", "Gildas", "Hervé", "Ismaël", "Jean-Marc", "Kossi",
               "Landry", "Mathieu", "Noël", "Olivier", "Parfait", "Romuald", "Serge", "Sylvain", "Thierry", "Ulrich"]
LAST_NAMES = ["Adjovi", "Agbodjan", "Ahouansou", "Akpovi", "Assogba", "Bocco", "Dagbo", "Djossou", "Dossa", "Gbaguidi",
              "Hounkpatin", "Houngbo", "Kiki", "Kpossou", "Lawson", "Mensah", "Noudéhou", "Sossa", "Tossou", "Zinsou"]
REQUEST_REASONS = [("quote", "Order for an event, beyond 50 bottles."),
                   ("complaint", "A bottle delivered damaged; the customer asks for a replacement."),
                   ("delivery", "The customer asks for a precise delivery slot."),
                   ("question", "Question about keeping the juices outside the refrigerator.")]
NOTE = ("Fictional data: Délices d'Awa and its customers are imaginary, created for “Mastering Claude”, "
        "Volume 2. The neighborhoods are real neighborhoods of Cotonou and its surroundings.")


class Clock:
    """A clock that the simulator moves forward by hand: the shop dates everything with it."""

    def __init__(self, instant: datetime):
        self.instant = instant

    def __call__(self) -> datetime:
        return self.instant


def make_customers(rng: random.Random, number: int = 140) -> list[dict]:
    """Fictional customers, each with their neighborhood; the first ones order much more often."""
    customers, seen = [], set()
    while len(customers) < number:
        name = f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}"
        if name in seen:
            continue
        seen.add(name)
        neighborhood = rng.choices(list(NEIGHBORHOODS), weights=list(NEIGHBORHOODS.values()))[0]
        customers.append({"name": name, "neighborhood": neighborhood, "weight": 1 / (1 + len(customers)) ** 0.8})
    return customers


def _products_of_the_day(day: date) -> dict:
    return {p: w for p, w in PRODUCTS.items() if not (p == "Soursop juice" and day >= SOURSOP_SHORTAGE)}


def _lines(rng: random.Random, day: date) -> list[dict]:
    products = _products_of_the_day(day)
    chosen = set(rng.choices(list(products), weights=list(products.values()), k=rng.choice([1, 1, 2, 2, 3])))
    lines = []
    for product in sorted(chosen, key=LINE_ORDER.index):
        quantity = rng.choice([1, 1, 2, 2, 2, 3, 4, 6])
        if rng.random() < 0.03:  # a birthday, a family gathering
            quantity = rng.choice([12, 18, 24, 30])
        lines.append({"product": product, "quantity": quantity})
    return lines


def simulate(path: Path, seed: int = SEED) -> dict:
    """Fills the shop's database, day after day. Returns a summary to check the result."""
    if path.exists():
        path.unlink()
    rng = random.Random(seed)
    customers = make_customers(rng)
    clock = Clock(datetime.combine(START, datetime.min.time(), COTONOU))
    # A large stock during the simulation: the chapter's question is what was sold.
    shop = Shop(str(path), stock={p: 1_000_000 for p in PRODUCTS}, clock=clock, rng=random.Random(seed + 1))
    tally = {"summaries": 0, "orders": 0, "abandonments": 0, "changes_of_mind": 0, "requests": 0}
    conversation_number = 0
    day = START
    while day <= END:
        mean = PER_DAY[day.weekday()]
        for _ in range(max(0, round(rng.gauss(mean, mean ** 0.5)))):
            conversation_number += 1
            conversation = f"wa-{conversation_number:05d}"
            customer = rng.choices(customers, weights=[c["weight"] for c in customers])[0]
            hour = rng.choices(range(8, 21), weights=[3, 5, 6, 6, 5, 3, 3, 4, 5, 6, 7, 6, 3])[0]
            clock.instant = datetime.combine(day, datetime.min.time(), COTONOU) + timedelta(
                hours=hour, minutes=rng.randrange(60))
            lines = _lines(rng, day)
            if sum(l["quantity"] for l in lines if not l["product"].endswith("syrup")) > MAXIMUM_WITHOUT_QUOTE:
                shop.pass_on(conversation, "quote", REQUEST_REASONS[0][1])
                tally["requests"] += 1
                continue
            try:
                summary = shop.prepare(conversation, lines, customer["name"], customer["neighborhood"])
            except ShopRefusal:
                continue
            tally["summaries"] += 1
            if rng.random() < 0.08:  # the customer changes their mind: a new summary replaces the old one
                clock.instant += timedelta(minutes=rng.randrange(2, 15))
                lines = _lines(rng, day)
                summary = shop.prepare(conversation, lines, customer["name"], customer["neighborhood"])
                tally["summaries"] += 1
                tally["changes_of_mind"] += 1
            if rng.random() < 0.78:
                clock.instant += timedelta(minutes=rng.randrange(1, 90))
                shop.confirm(conversation, summary["confirmation_code"])
                tally["orders"] += 1
            else:
                tally["abandonments"] += 1
            if rng.random() < 0.04:
                reason, text = rng.choice(REQUEST_REASONS[1:])
                clock.instant += timedelta(minutes=rng.randrange(5, 120))
                shop.pass_on(conversation, reason, text)
                tally["requests"] += 1
        day += timedelta(days=1)
    # This morning's stock, the one of chapter 9: soursop is out of stock.
    stock = json.loads((ROOT / "comptoir" / "data" / "initial_stock.json").read_text(encoding="utf-8"))["stock"]
    Shop(str(path), stock=stock)
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE IF NOT EXISTS about (note TEXT NOT NULL)")
        db.execute("INSERT INTO about VALUES (?)", (NOTE,))
    return tally


def copy_for_exploration(source: Path, copy: Path) -> int:
    """Copies the database, removing what Claude does not need to read. Returns the number of pseudonymized customers.

    The names become “Customer 001”, “Customer 002”… in the order of their first order,
    the conversations “conv-00001”…, and the confirmation codes are emptied. VACUUM rewrites
    the file: without it, the old values stay readable in the freed pages.
    """
    if copy.exists():
        copy.unlink()
    with sqlite3.connect(source) as origin, sqlite3.connect(copy) as target:
        origin.backup(target)
    db = sqlite3.connect(copy)
    try:
        names = [n for (n,) in db.execute(
            "SELECT customer_name FROM summaries GROUP BY customer_name ORDER BY MIN(created_at)")]
        pseudonyms = {name: f"Customer {i:03d}" for i, name in enumerate(names, start=1)}
        conversations = [c for (c,) in db.execute(
            "SELECT conversation FROM (SELECT conversation, created_at FROM summaries UNION ALL "
            "SELECT conversation, created_at FROM requests) GROUP BY conversation ORDER BY MIN(created_at)")]
        alias = {c: f"conv-{i:05d}" for i, c in enumerate(conversations, start=1)}
        with db:
            db.executemany("UPDATE summaries SET customer_name = ? WHERE customer_name = ?",
                           [(p, n) for n, p in pseudonyms.items()])
            for table in ("summaries", "orders", "requests"):
                db.executemany(f"UPDATE {table} SET conversation = ? WHERE conversation = ?",
                               [(a, c) for c, a in alias.items()])
            db.execute("UPDATE summaries SET code = ''")
            db.execute("DELETE FROM about")
            db.execute("INSERT INTO about VALUES (?)", (
                NOTE + " Exploration copy: customers' names and conversations pseudonymized, "
                "confirmation codes erased.",))
        db.execute("VACUUM")
    finally:
        db.close()
    return len(pseudonyms)


def main() -> None:
    tally = simulate(DATABASE)
    customers = copy_for_exploration(DATABASE, COPY)
    print(f"Shop database: {DATABASE.relative_to(ROOT)}")
    print(f"  {tally['summaries']} summaries, {tally['orders']} orders, "
          f"{tally['abandonments']} abandonments, {tally['changes_of_mind']} changes of mind, "
          f"{tally['requests']} requests passed on to Awa")
    print(f"Exploration copy: {COPY.relative_to(ROOT)} ({customers} pseudonymized customers)")


if __name__ == "__main__":
    main()
