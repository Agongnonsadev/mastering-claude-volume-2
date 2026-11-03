"""Comptoir for Awa: the MCP server of Délices d'Awa (chapter 15).

Awa plugs it into her Claude app, as a desktop extension; Yao, into Claude Code.
What Claude can do with it:
- read: the orders of a day, the stock, the sales of a week, one order, the catalog;
- prepare: an evening review, an inventory (two prompts that Awa chooses);
- write, a single thing: correct the stock after an inventory, in two steps. prepare_correction
  shows the difference and returns a token; apply_correction accepts only that token, only once, within
  ten minutes, and only if the stock has not moved in the meantime. In between, Awa says yes.

The module depends only on the standard library and the MCP SDK: it can be packaged on its own (ch15/
build_extension.py). Configuration, through the environment:
  COMPTOIR_SHOP       path of the shop's SQLite database (required)
  COMPTOIR_CATALOG    path of the JSON catalog (default: catalog.json next to this file,
                      otherwise comptoir/data/delices_awa.json in the repository)
  COMPTOIR_TODAY      today's date, YYYY-MM-DD, for demonstrations (optional)

Run: python comptoir_for_awa.py  (stdio). Nothing is written on standard output, which
belongs to the protocol: the log goes to standard error.
"""

import json
import logging
import os
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, Field

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

VERSION = "0.1.0"
COTONOU = timezone(timedelta(hours=1))  # Benin is at UTC+1, with no daylight saving time
CORRECTION_VALIDITY = timedelta(minutes=10)
MAXIMUM_DIFFERENCE = 200  # beyond that, it is no longer an inventory correction: Awa does it herself
LOW_THRESHOLDS = {"juice": 10, "syrup": 5}
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"]

log = logging.getLogger("comptoir_for_awa")

INSTRUCTIONS = """Comptoir for Awa gives access to the sales and the stock of Délices d'Awa, Awa's juice business in Cotonou. Rules:
1. The figures (bottles, amounts, differences) come from the tools: do not recalculate them and do not round them.
2. To correct the stock: call prepare_correction, show Awa the difference as the tool gives it, and wait for her explicit consent before apply_correction. One correction per product, never several in a row without consent for each.
3. Never offer to change anything other than the stock: orders and customers are not changed here.
4. Answer Awa in English, politely, simply: she is not a computer specialist."""


# ---------- Configuration and database ------------------------------------------------------


def _database_path() -> Path:
    raw = os.environ.get("COMPTOIR_SHOP", "").strip()
    if not raw or "${" in raw:
        raise ToolError("No shop database is set. In the settings of the Comptoir for Awa extension, "
                        "choose the “Shop database” file.")
    path = Path(raw)
    if not path.is_file():
        raise ToolError(f"The shop's database cannot be found: {path}. Check the extension's “Shop database” "
                        "setting, or ask Yao for the right file.")
    return path


def _open() -> sqlite3.Connection:
    db = sqlite3.connect(_database_path(), timeout=10)
    db.row_factory = sqlite3.Row
    return db


def _catalog() -> dict:
    candidates = [os.environ.get("COMPTOIR_CATALOG", "").strip(), Path(__file__).with_name("catalog.json"),
                  Path(__file__).parents[1] / "comptoir" / "data" / "delices_awa.json"]
    for c in candidates:
        if c and Path(c).is_file():
            return json.loads(Path(c).read_text(encoding="utf-8"))
    raise ToolError("The Délices d'Awa catalog cannot be found: reinstall the extension.")


def _today() -> date:
    forced = os.environ.get("COMPTOIR_TODAY", "").strip()
    return date.fromisoformat(forced) if forced and "${" not in forced else datetime.now(COTONOU).date()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _local(timestamp: str) -> datetime:
    """The database's dates, in Cotonou time, whatever the time zone they were written in."""
    return datetime.fromisoformat(timestamp).astimezone(COTONOU)


# ---------- Formatting for Awa ------------------------------------------------------


def fcfa(amount: int) -> str:
    """12500 -> “12,500 FCFA”."""
    return f"{amount:,} FCFA"


def day_in_full(d: date) -> str:
    return f"{DAYS[d.weekday()]}, {MONTHS[d.month - 1]} {d.day}, {d.year}"


def discreet_customer(name: str) -> str:
    """“Larissa Noudéhou” -> “Larissa N.”: enough to deliver, without the full name."""
    parts = name.split()
    return parts[0] if len(parts) == 1 else f"{parts[0]} {parts[-1][0]}."


# ---------- Reads ----------------------------------------------------------------------


@dataclass
class _Order:
    number: str
    when: datetime
    customer: str
    neighborhood: str
    lines: list[dict]
    fee: int
    total: int


def _orders(db: sqlite3.Connection) -> list[_Order]:
    rows = db.execute(
        "SELECT o.id, o.created_at, o.total, s.customer_name, s.neighborhood, s.lines, s.delivery_fee "
        "FROM orders o JOIN summaries s ON s.id = o.summary ORDER BY o.created_at").fetchall()
    return [_Order(r["id"], _local(r["created_at"]), discreet_customer(r["customer_name"]), r["neighborhood"],
                   json.loads(r["lines"]), r["delivery_fee"], r["total"]) for r in rows]


class OrderOfTheDay(BaseModel):
    number: str
    time: str
    customer: str = Field(description="First name and initial of the surname.")
    neighborhood: str
    products: str
    total_fcfa: int


class OrdersOfTheDay(BaseModel):
    day: str
    count: int
    total_fcfa: int
    orders: list[OrderOfTheDay]
    summary: str = Field(description="A sentence to say to Awa, with the exact figures.")


class StockLine(BaseModel):
    product: str
    format: str
    quantity: int
    state: Literal["out_of_stock", "low", "sufficient"]


class Stock(BaseModel):
    products: list[StockLine]
    summary: str


class ProductSales(BaseModel):
    product: str
    quantity: int
    amount_fcfa: int


class WeekSales(BaseModel):
    start: str
    end: str
    orders: int
    total_fcfa: int
    by_product: list[ProductSales]
    previous_week_fcfa: int
    summary: str


class Correction(BaseModel):
    product: str
    current_stock: int
    counted_quantity: int
    difference: int
    token: str
    valid_until: str
    to_tell_awa: str


class AppliedCorrection(BaseModel):
    product: str
    before: int
    after: int
    summary: str


def _products(catalog: dict) -> dict[str, dict]:
    return {p["name"]: p for p in catalog["products"]}


def _kind(product: dict) -> str:
    # The juices come in 500 ml bottles, the syrups in smaller bottles: their low stock is counted apart.
    return "juice" if product["format"].endswith("ml bottle") else "syrup"


def read_orders_of_the_day(db: sqlite3.Connection, day: date) -> OrdersOfTheDay:
    of_the_day = [o for o in _orders(db) if o.when.date() == day]
    orders = [OrderOfTheDay(
        number=o.number, time=o.when.strftime("%H:%M"), customer=o.customer, neighborhood=o.neighborhood,
        products=", ".join(f"{l['quantity']} × {l['product']}" for l in o.lines), total_fcfa=o.total)
        for o in of_the_day]
    total = sum(o.total for o in of_the_day)
    when = day_in_full(day)
    summary = (f"No order on {when}." if not of_the_day else
               f"{len(of_the_day)} order{'s' if len(of_the_day) > 1 else ''} on {when}, for {fcfa(total)}.")
    return OrdersOfTheDay(day=day.isoformat(), count=len(of_the_day), total_fcfa=total, orders=orders,
                          summary=summary)


def read_stock(db: sqlite3.Connection, catalog: dict) -> Stock:
    quantities = dict(db.execute("SELECT product, quantity FROM stock").fetchall())
    lines = []
    for name, product in _products(catalog).items():
        quantity = quantities.get(name, 0)
        state = "out_of_stock" if quantity == 0 else "low" if quantity < LOW_THRESHOLDS[_kind(product)] else "sufficient"
        lines.append(StockLine(product=name, format=product["format"], quantity=quantity, state=state))
    out_of_stock = [l.product for l in lines if l.state == "out_of_stock"]
    low = [f"{l.product} ({l.quantity})" for l in lines if l.state == "low"]
    parts = []
    if out_of_stock:
        parts.append("Out of stock: " + ", ".join(out_of_stock) + ".")
    if low:
        parts.append("Low stock: " + ", ".join(low) + ".")
    return Stock(products=lines, summary=" ".join(parts) or "All the products are in stock.")


def read_sales_of_the_week(db: sqlite3.Connection, catalog: dict, a_day: date) -> WeekSales:
    monday = a_day - timedelta(days=a_day.weekday())
    sunday = monday + timedelta(days=6)
    orders = _orders(db)
    week = [o for o in orders if monday <= o.when.date() <= sunday]
    previous = [o for o in orders if monday - timedelta(days=7) <= o.when.date() < monday]
    quantities: dict[str, int] = {}
    amounts: dict[str, int] = {}
    for o in week:
        for l in o.lines:
            quantities[l["product"]] = quantities.get(l["product"], 0) + l["quantity"]
            amounts[l["product"]] = amounts.get(l["product"], 0) + l["quantity"] * l["unit_price"]
    by_product = [ProductSales(product=p, quantity=quantities[p], amount_fcfa=amounts[p])
                  for p in sorted(quantities, key=lambda p: -quantities[p])]
    total = sum(o.total for o in week)
    before = sum(o.total for o in previous)
    trend = ""
    if before:
        change = round(100 * (total - before) / before)
        trend = f" ({'+' if change >= 0 else ''}{change}% compared with the previous week)"
    best = f" Best seller: {by_product[0].product}, {by_product[0].quantity}." if by_product else ""
    summary = (f"From {day_in_full(monday)} to {day_in_full(sunday)}: {len(week)} "
               f"orders, {fcfa(total)}{trend}.{best}")
    return WeekSales(start=monday.isoformat(), end=sunday.isoformat(), orders=len(week), total_fcfa=total,
                     by_product=by_product, previous_week_fcfa=before, summary=summary)


# ---------- The only write: correcting the stock ----------------------------------------

_CORRECTIONS_TABLE = """CREATE TABLE IF NOT EXISTS stock_corrections (
    token TEXT PRIMARY KEY, product TEXT NOT NULL, before INTEGER NOT NULL, after INTEGER NOT NULL,
    prepared_at TEXT NOT NULL, status TEXT NOT NULL, applied_at TEXT)"""


def prepare(db: sqlite3.Connection, catalog: dict, product: str, counted_quantity: int,
            now: datetime) -> Correction:
    if product not in _products(catalog):
        raise ToolError(f"“{product}” is not in the catalog. Products: {', '.join(_products(catalog))}.")
    (current,) = db.execute("SELECT quantity FROM stock WHERE product = ?", (product,)).fetchone() or (0,)
    difference = counted_quantity - current
    if abs(difference) > MAXIMUM_DIFFERENCE:
        raise ToolError(f"The difference would be {difference} for {product}: that is too much for an inventory "
                        "correction. Check the count; for a restocking, Awa goes through the Comptoir's screen.")
    # The token is recorded in the database, not in memory: it survives a restart of the server,
    # and a stateless remote server (chapter 16) will find it the same way.
    token = secrets.token_hex(4)
    with db:
        db.execute(_CORRECTIONS_TABLE)
        db.execute("INSERT INTO stock_corrections VALUES (?, ?, ?, ?, ?, 'prepared', NULL)",
                   (token, product, current, counted_quantity, now.isoformat()))
    end = (now + CORRECTION_VALIDITY).astimezone(COTONOU)
    if difference == 0:
        say = f"The stock of {product} is already {current}: nothing to correct."
    else:
        direction = "more" if difference > 0 else "fewer"
        say = (f"The Comptoir counts {current} for {product}; you counted {counted_quantity}, that is "
               f"{abs(difference)} {direction}. Do you want the stock to go to {counted_quantity}?")
    return Correction(product=product, current_stock=current, counted_quantity=counted_quantity,
                      difference=difference, token=token, valid_until=end.strftime("%H:%M"), to_tell_awa=say)


def apply(db: sqlite3.Connection, token: str, now: datetime) -> AppliedCorrection:
    db.execute(_CORRECTIONS_TABLE)
    row = db.execute("SELECT * FROM stock_corrections WHERE token = ?", (token.strip(),)).fetchone()
    if row is None or row["status"] != "prepared":
        raise ToolError("This token is unknown or has already been used. Prepare a new correction with "
                        "prepare_correction and show the difference to Awa.")
    if now - datetime.fromisoformat(row["prepared_at"]) > CORRECTION_VALIDITY:
        with db:
            db.execute("UPDATE stock_corrections SET status = 'expired' WHERE token = ?", (row["token"],))
        raise ToolError("This token has expired (10 minutes). Prepare the correction again and ask Awa for "
                        "her consent again.")
    with db:
        (current,) = db.execute("SELECT quantity FROM stock WHERE product = ?", (row["product"],)).fetchone() or (0,)
        if current != row["before"]:
            db.execute("UPDATE stock_corrections SET status = 'outdated' WHERE token = ?", (row["token"],))
            raise ToolError(f"The stock of {row['product']} has changed since the preparation ({row['before']} → "
                            f"{current}, probably a sale). Prepare a new correction.")
        db.execute("INSERT OR REPLACE INTO stock VALUES (?, ?)", (row["product"], row["after"]))
        db.execute("UPDATE stock_corrections SET status = 'applied', applied_at = ? WHERE token = ?",
                   (now.isoformat(), row["token"]))
    log.info("correction applied: %s %s -> %s", row["product"], row["before"], row["after"])
    return AppliedCorrection(product=row["product"], before=row["before"], after=row["after"],
                             summary=f"Done: the stock of {row['product']} went from {row['before']} "
                                     f"to {row['after']}.")


# ---------- The MCP server ------------------------------------------------------------------

server = MCPServer("comptoir-for-awa", title="Comptoir for Awa", version=VERSION, instructions=INSTRUCTIONS)

READ_ONLY = ToolAnnotations(read_only_hint=True, open_world_hint=False)
Product = Literal["Bissap juice", "Ginger juice", "Pineapple juice", "Soursop juice", "Bissap syrup",
                  "Ginger syrup"]


@server.tool(title="Orders of a day", annotations=READ_ONLY)
def orders_of_the_day(
    day: Annotated[date | None, Field(description="YYYY-MM-DD. Without a date: today.")] = None,
) -> OrdersOfTheDay:
    """The confirmed orders of a day: time, customer, neighborhood, products, total. For “my orders
    today”, “what did I deliver on Saturday”. Changes nothing."""
    with _open() as db:
        return read_orders_of_the_day(db, day or _today())


@server.tool(title="Stock", annotations=READ_ONLY)
def stock() -> Stock:
    """The stock of each product, with the shortages and the low stocks. Changes nothing."""
    with _open() as db:
        return read_stock(db, _catalog())


@server.tool(title="Sales of a week", annotations=READ_ONLY)
def sales_of_the_week(
    a_day_of_the_week: Annotated[date | None, Field(
        description="YYYY-MM-DD, any day of the week wanted (Monday to Sunday). "
                    "Without a date: the current week.")] = None,
) -> WeekSales:
    """The sales of a week, Monday to Sunday: orders, total, bottles per product, and
    comparison with the previous week. Changes nothing."""
    with _open() as db:
        return read_sales_of_the_week(db, _catalog(), a_day_of_the_week or _today())


# prepare_correction writes a draft correction (the token), never the stock: so it is not
# “read-only”, but it destroys nothing.
@server.tool(title="Prepare a stock correction",
             annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False,
                                         open_world_hint=False))
def prepare_correction(
    product: Product,
    counted_quantity: Annotated[int, Field(ge=0, le=1000, description="What Awa counted on the shelf.")],
) -> Correction:
    """First step of a stock correction after an inventory: compares what Awa counted with the Comptoir's
    stock and returns the difference with a token valid for 10 minutes. Does not change the stock. Show
    the difference to Awa (to_tell_awa) and wait for her consent before apply_correction."""
    with _open() as db:
        return prepare(db, _catalog(), product, counted_quantity, _now())


@server.tool(
    title="Apply a stock correction",
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=False,
                                open_world_hint=False),
    # Claude Code asks for the person's consent at each call, whatever the permission mode.
    meta={"anthropic/requiresUserInteraction": True},
)
def apply_correction(token: Annotated[str, Field(description="The token returned by prepare_correction.")],
                     ) -> AppliedCorrection:
    """Second step: replaces the product's stock with the counted quantity. Only with a token from
    prepare_correction, and only after Awa's explicit consent to the difference announced. A token
    can be used only once."""
    with _open() as db:
        return apply(db, token, _now())


@server.resource("comptoir://catalog", title="Catalog and terms", mime_type="text/markdown")
def catalog() -> str:
    """The products of Délices d'Awa, their prices and the ordering and delivery terms."""
    c = _catalog()
    lines = ["# Délices d'Awa: catalog", ""]
    lines += [f"- {p['name']} ({p['format']}): {fcfa(p['price_fcfa'])}" for p in c["products"]]
    lines += ["", "## Terms", ""] + [f"- {term}" for term in c["terms"]]
    return "\n".join(lines)


@server.resource("comptoir://order/{number}", title="One order", mime_type="text/markdown")
def one_order(number: str) -> str:
    """The details of an order, by its number (for example C-0042)."""
    with _open() as db:
        for o in _orders(db):
            if o.number == number:
                lines = [f"# Order {o.number}", "", f"- Date: {day_in_full(o.when.date())}, "
                         f"{o.when.strftime('%H:%M')}", f"- Customer: {o.customer}, {o.neighborhood}"]
                lines += [f"- {l['quantity']} × {l['product']} at {fcfa(l['unit_price'])}" for l in o.lines]
                lines += [f"- Delivery: {fcfa(o.fee) if o.fee else 'free'}", f"- Total: {fcfa(o.total)}"]
                return "\n".join(lines)
    raise ToolError(f"No order has the number {number}.")


@server.prompt(title="Evening review")
def evening_review(day: str = "") -> str:
    """The end-of-day review: orders, stock to watch, what to prepare for tomorrow."""
    when = f"for {day}" if day else "for today"
    return (f"Give me the evening review {when}, in five lines at most: the number of orders and the total "
            "(orders_of_the_day tool), the products out of stock or low in stock (stock tool), and what I "
            "must prepare or order for tomorrow. Give the figures as the tools return them. Do not "
            "change anything.")


@server.prompt(title="Inventory")
def inventory() -> str:
    """Guides the inventory product by product, with a stock correction only after consent."""
    return ("I am doing my inventory. For each product I give you with the counted quantity, prepare the "
            "correction (prepare_correction), tell me the difference, and wait for me to answer yes before "
            "applying it. One product at a time. At the end, summarize what changed.")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")  # on standard error
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
