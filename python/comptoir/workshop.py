"""Awa's workshop: sales, stock, recipes, suppliers, events and purchase orders (chapter 13).

The restocking agent reads these data through its tools and proposes a purchase order.
Everything that can be calculated is calculated here: the sales per week, the item needs, the
check and the total of the order. The agent does no addition that matters, and it sends nothing:
an order stays “to be approved” as long as Awa has not approved it herself.
"""

import csv
import json
import math
import uuid
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

DATA = Path(__file__).parent / "data" / "workshop"
TODAY = date(2026, 10, 19)        # the Monday of the purchase order, in the story
CEILING_FCFA = 250_000            # the most Awa commits on one order, without first talking to her bank
HORIZON_DAYS = 60                 # a desired delivery beyond that is not ordered today

TO_APPROVE, APPROVED, REJECTED, REPLACED = "to be approved by Awa", "approved by Awa", "rejected by Awa", "replaced"


class InvalidOrder(Exception):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


@dataclass
class Order:
    code: str
    lines: list[dict]           # item, supplier, quantity, unit, desired_delivery, price_fcfa, amount_fcfa
    total_fcfa: int
    justification: str
    alerts: list[str]
    status: str = TO_APPROVE
    created_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    decision_note: str | None = None


def _read_json(folder: Path, name: str) -> dict:
    return json.loads((folder / name).read_text(encoding="utf-8"))


def _fcfa(amount: float) -> str:
    return f"{round(amount):,} FCFA"


def _units(unit: str, quantity: float) -> str:
    """“unit” -> “units” in the plural; “kg” does not change."""
    return unit + "s" if quantity >= 2 and unit in ("unit", "piece") else unit


def _number(value: float) -> str:
    """2.0 -> “2”, 2.5 -> “2.5”: readable quantities, without false decimals."""
    return f"{value:g}"


class Workshop:
    def __init__(self, folder: Path = DATA, today: date = TODAY, ceiling_fcfa: int = CEILING_FCFA,
                 orders: Path | None = None):
        self.folder, self.today, self.ceiling_fcfa = folder, today, ceiling_fcfa
        self.orders_path = orders    # None: the orders stay in memory (tests, measurements)
        self._orders: dict[str, Order] = {}
        if orders and orders.exists():
            self._orders = {o["code"]: Order(**o) for o in json.loads(orders.read_text(encoding="utf-8"))}

    # --- Reading -------------------------------------------------------------------------

    def weekly_sales(self) -> dict[str, dict[str, dict[str, int]]]:
        """{monday: {product: {"usual": n, "event": n}}}, calculated on the sales file."""
        weeks: dict[str, dict[str, dict[str, int]]] = defaultdict(lambda: defaultdict(lambda: {"usual": 0,
                                                                                                 "event": 0}))
        with (self.folder / "sales.csv").open(encoding="utf-8") as f:
            for line in csv.DictReader(f):
                day = date.fromisoformat(line["date"])
                monday = (day - timedelta(days=day.weekday())).isoformat()
                kind = "event" if line["channel"] == "event" else "usual"
                weeks[monday][line["product"]][kind] += int(line["quantity"])
        return {w: dict(p) for w, p in sorted(weeks.items())}

    def products(self) -> list[str]:
        return list(self.recipes()["recipes"])

    def sales_summary(self) -> str:
        """The table the agent reads: usual sales per week, averages, and event orders set apart."""
        weeks = self.weekly_sales()
        lines = ["Usual sales per week (bottles or flasks), event orders excluded:"]
        for monday, sales in weeks.items():
            lines.append(f"- week of {monday}: " + ", ".join(
                f"{p} {sales.get(p, {}).get('usual', 0)}" for p in self.products()))
        last = list(weeks.values())[-4:]
        lines.append("Averages per week (calculated by the code):")
        for p in self.products():
            over_8 = sum(v.get(p, {}).get("usual", 0) for v in weeks.values()) / len(weeks)
            over_4 = sum(v.get(p, {}).get("usual", 0) for v in last) / len(last)
            lines.append(f"- {p}: {over_8:.1f} over 8 weeks, {over_4:.1f} over the last 4")
        events = [(monday, p, n["event"]) for monday, v in weeks.items() for p, n in v.items() if n["event"]]
        lines.append("Past event orders (one-off): " + ("; ".join(
            f"week of {monday}, {p} {n}" for monday, p, n in events) or "none"))
        return "\n".join(lines)

    def stock(self) -> dict:
        return _read_json(self.folder, "stock.json")

    def recipes(self) -> dict:
        return _read_json(self.folder, "recipes.json")

    def offers(self) -> list[dict]:
        return _read_json(self.folder, "suppliers.json")["offers"]

    def events(self) -> list[dict]:
        return _read_json(self.folder, "events.json")["events"]

    def supplier_messages(self) -> str:
        return (self.folder / "supplier-messages.md").read_text(encoding="utf-8")

    def unit(self, item: str) -> str:
        return self.recipes()["units"].get(item, "unit")

    # --- Calculations ------------------------------------------------------------------------

    def needs(self, production: dict[str, int]) -> list[dict]:
        """What a production (bottles or flasks per product) requires, minus the stock of items,
        and, for each offer, the quantity to order that respects the minimum and the pack size."""
        unknown = [p for p in production if p not in self.recipes()["recipes"]]
        if unknown:
            raise ValueError(f"unknown products: {', '.join(unknown)}; known products: {', '.join(self.products())}")
        gross: dict[str, float] = defaultdict(float)
        for product, count in production.items():
            for item, per_unit in self.recipes()["recipes"][product].items():
                gross[item] += per_unit * count
        in_stock = self.stock()["items"]
        result = []
        for item, need in gross.items():
            net = max(0.0, need - in_stock.get(item, 0))
            suggestions = []
            for o in (o for o in self.offers() if o["item"] == item):
                quantity = 0 if net == 0 else max(o["minimum"], math.ceil(net / o["pack_size"] - 1e-9)
                                                  * o["pack_size"])
                suggestions.append({"supplier": o["supplier"], "quantity": quantity,
                                    "amount_fcfa": round(quantity * o["price_fcfa"])})
            result.append({"item": item, "unit": self.unit(item), "need": round(need, 3),
                           "stock": in_stock.get(item, 0), "net_need": round(net, 3),
                           "to_order_per_sheets": suggestions})
        return result

    def check(self, lines: list[dict]) -> list[str]:
        """The errors of a draft order; an empty list if it respects the sheets and the ceiling."""
        errors, total, seen = [], 0.0, set()
        if not lines:
            return ["the order contains no line"]
        for i, line in enumerate(lines, start=1):
            item, supplier = line.get("item"), line.get("supplier")
            offer = next((o for o in self.offers() if o["item"] == item and o["supplier"] == supplier), None)
            if offer is None:
                sellers = [o["supplier"] for o in self.offers() if o["item"] == item]
                errors.append(f"line {i}: {supplier!r} does not sell {item!r}" +
                              (f" (suppliers of this item: {', '.join(sellers)})" if sellers else
                               " (unknown item)"))
                continue
            quantity = float(line.get("quantity") or 0)
            if quantity < offer["minimum"]:
                errors.append(f"line {i}: {_number(quantity)} {item}, below the minimum of "
                              f"{offer['minimum']} at {supplier}")
            elif abs(quantity / offer["pack_size"] - round(quantity / offer["pack_size"])) > 1e-9:
                unit = self.unit(item)
                errors.append(f"line {i}: {supplier} sells {item} in units of {offer['pack_size']}"
                              + ("" if unit in ("unit", "piece") else f" {unit}"))
            try:
                delivery = date.fromisoformat(str(line.get("desired_delivery")))
            except ValueError:
                errors.append(f"line {i}: unreadable delivery date ({line.get('desired_delivery')!r}), "
                              "expected format YYYY-MM-DD")
            else:
                earliest = self.today + timedelta(days=offer["lead_time_days"])
                if delivery < earliest:
                    errors.append(f"line {i}: delivery on {delivery} impossible, {supplier}'s lead time is "
                                  f"{offer['lead_time_days']} days (at the earliest {earliest})")
                elif delivery > self.today + timedelta(days=HORIZON_DAYS):
                    errors.append(f"line {i}: delivery on {delivery}, too far away to order it today")
                key = (item, supplier, delivery)
                if key in seen:
                    errors.append(f"line {i}: duplicate ({item}, {supplier}, {delivery})")
                seen.add(key)
            total += quantity * offer["price_fcfa"]
        if total > self.ceiling_fcfa:
            errors.append(f"total of {_fcfa(total)}, above the ceiling of {_fcfa(self.ceiling_fcfa)} set by Awa")
        return errors

    # --- The purchase order --------------------------------------------------------------

    def propose(self, lines: list[dict], justification: str, alerts: list[str] | None = None) -> Order:
        """Records a draft order, to be approved by Awa. Raises InvalidOrder if the sheets are not respected.
        Nothing is sent to a supplier: it is Awa who sends an approved order."""
        errors = self.check(lines)
        if errors:
            raise InvalidOrder(errors)
        detail = []
        for line in lines:
            offer = next(o for o in self.offers() if o["item"] == line["item"]
                         and o["supplier"] == line["supplier"])
            quantity = float(line["quantity"])
            detail.append({"item": line["item"], "supplier": line["supplier"],
                           "quantity": quantity, "unit": self.unit(line["item"]),
                           "desired_delivery": str(line["desired_delivery"]),
                           "price_fcfa": offer["price_fcfa"], "amount_fcfa": round(quantity * offer["price_fcfa"])})
        order = Order(f"BC-{uuid.uuid4().hex[:6]}", detail, sum(l["amount_fcfa"] for l in detail), justification,
                      list(alerts or []))
        self._orders[order.code] = order
        self._save()
        return order

    def withdraw(self, code: str, replaced_by: str) -> None:
        """A draft order that the agent replaces with another, in the same session: it is no longer to be approved."""
        order = self._orders[code]
        if order.status == TO_APPROVE:
            order.status = f"{REPLACED} by {replaced_by}"
            self._save()

    def decide(self, code: str, approved: bool, note: str | None = None) -> Order:
        """Awa's decision, outside the agent: the only way to take an order out of “to be approved”."""
        order = self._orders[code]
        if order.status != TO_APPROVE:
            raise ValueError(f"order {code} is already {order.status}")
        order.status, order.decision_note = (APPROVED if approved else REJECTED), note
        self._save()
        return order

    def orders(self) -> list[Order]:
        return list(self._orders.values())

    def _save(self) -> None:
        if self.orders_path:
            self.orders_path.parent.mkdir(parents=True, exist_ok=True)
            self.orders_path.write_text(json.dumps([asdict(o) for o in self._orders.values()], ensure_ascii=False,
                                                   indent=2), encoding="utf-8")


def render_order(order: Order) -> str:
    lines = [f"Order {order.code} — {order.status} — total {_fcfa(order.total_fcfa)}"]
    for l in order.lines:
        lines.append(f"- {_number(l['quantity'])} {_units(l['unit'], l['quantity'])} of {l['item']} from {l['supplier']}, "
                     f"delivery on {l['desired_delivery']}: {_fcfa(l['amount_fcfa'])}")
    if order.alerts:
        lines.append("Alerts: " + " | ".join(order.alerts))
    return "\n".join(lines)
