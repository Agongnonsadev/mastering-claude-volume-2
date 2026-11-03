"""Chapter 14: the right answers to Yao's questions, calculated by the code on the copy.

Before asking Claude anything, we know what it must find: that is what makes it possible
to check its answers, and not to believe them.
"""

import sqlite3
from pathlib import Path

from ch14.servers import ROOT

COPY = ROOT / "customer_data" / "orders_exploration.sqlite3"
# The last four complete weeks of the history: from Monday September 21 to Sunday October 18.
PERIOD_START, PERIOD_END = "2026-09-21", "2026-10-19"


def compute(path: Path = COPY) -> dict:
    db = sqlite3.connect(path)
    try:
        neighborhoods = db.execute(
            "SELECT s.neighborhood, COUNT(*), SUM(o.total) FROM orders o JOIN summaries s "
            "ON s.id = o.summary WHERE o.created_at >= ? AND o.created_at < ? "
            "GROUP BY s.neighborhood ORDER BY SUM(o.total) DESC LIMIT 3", (PERIOD_START, PERIOD_END)).fetchall()
        # An abandoned conversation: summaries, and none of them became an order.
        conversations, abandonments = db.execute(
            "SELECT COUNT(*), SUM(confirmed = 0) FROM (SELECT conversation, MAX(status = 'confirmed') AS confirmed "
            "FROM summaries GROUP BY conversation)").fetchone()
        hours = db.execute(
            "SELECT CAST(substr(created_at, 12, 2) AS INTEGER) AS h, COUNT(*), SUM(status = 'pending') "
            "FROM summaries WHERE status != 'replaced' GROUP BY h HAVING COUNT(*) >= 20 "
            "ORDER BY 1.0 * SUM(status = 'pending') / COUNT(*) DESC LIMIT 1").fetchone()
        (soursop,) = db.execute(
            "SELECT SUM(json_extract(j.value, '$.quantity')) FROM orders o JOIN summaries s "
            "ON s.id = o.summary, json_each(s.lines) j "
            "WHERE json_extract(j.value, '$.product') = 'Soursop juice'").fetchone()
    finally:
        db.close()
    return {
        "neighborhoods": [{"neighborhood": n, "orders": count, "fcfa": revenue} for n, count, revenue in neighborhoods],
        "conversations": conversations,
        "abandonments": abandonments,
        "abandonment_share": round(100 * abandonments / conversations, 1),
        "worst_abandonment_hour": hours[0],
        "worst_hour_rate": round(100 * hours[2] / hours[1], 1),
        "soursop_bottles": soursop,
    }


def bottles(product: str, start: str, end: str, path: Path = COPY) -> dict:
    """The bottles of a product sold between two dates (end excluded), in total and per neighborhood."""
    db = sqlite3.connect(path)
    try:
        lines = db.execute(
            "SELECT s.neighborhood, SUM(json_extract(j.value, '$.quantity')) AS n FROM orders o "
            "JOIN summaries s ON s.id = o.summary, json_each(s.lines) j "
            "WHERE json_extract(j.value, '$.product') = ? AND o.created_at >= ? AND o.created_at < ? "
            "GROUP BY s.neighborhood ORDER BY n DESC", (product, start, end)).fetchall()
    finally:
        db.close()
    return {"total": sum(n for _, n in lines), "by_neighborhood": dict(lines)}
