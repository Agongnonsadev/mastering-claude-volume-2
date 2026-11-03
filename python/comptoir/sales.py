"""A week's sales, calculated by our code: the report's reference (chapter 10).

Claude calculates the report in its container; this module redoes the same calculations, here,
to check each figure before Awa reads it.
"""

import csv
from collections import defaultdict
from pathlib import Path


def read(path: str | Path) -> list[dict]:
    with open(path, encoding="utf-8", newline="") as f:
        return [{**line, "quantity": int(line["quantity"]), "unit_price_fcfa": int(line["unit_price_fcfa"])}
                for line in csv.DictReader(f)]


def totals(lines: list[dict]) -> dict:
    by_product = defaultdict(lambda: {"quantity": 0, "amount_fcfa": 0})
    by_day, by_neighborhood = defaultdict(int), defaultdict(int)
    for line in lines:
        amount = line["quantity"] * line["unit_price_fcfa"]
        by_product[line["product"]]["quantity"] += line["quantity"]
        by_product[line["product"]]["amount_fcfa"] += amount
        by_day[line["date"]] += amount
        by_neighborhood[line["neighborhood"]] += amount
    total = sum(by_day.values())
    orders = len({line["order"] for line in lines})
    return {
        "revenue_fcfa": total,
        "orders": orders,
        "average_basket_fcfa": round(total / orders) if orders else 0,
        "by_product": dict(sorted(by_product.items())),
        "by_day": dict(sorted(by_day.items())),
        "by_neighborhood": dict(sorted(by_neighborhood.items())),
    }


def compare(summary: dict, expected: dict) -> list[str]:
    """The gaps between the summary produced by Claude and our calculation. Empty list: everything matches."""
    gaps = []
    for key in ("revenue_fcfa", "orders"):
        if summary.get(key) != expected[key]:
            gaps.append(f"{key}: {summary.get(key)!r} instead of {expected[key]}")
    if abs((summary.get("average_basket_fcfa") or 0) - expected["average_basket_fcfa"]) > 1:  # the rounding may differ
        gaps.append(f"average_basket_fcfa: {summary.get('average_basket_fcfa')!r} instead of {expected['average_basket_fcfa']}")
    for key in ("by_day", "by_neighborhood"):
        got = summary.get(key) or {}
        for name, value in expected[key].items():
            if got.get(name) != value:
                gaps.append(f"{key}[{name}]: {got.get(name)!r} instead of {value}")
    got = summary.get("by_product") or {}
    for product, values in expected["by_product"].items():
        if got.get(product) != values:
            gaps.append(f"by_product[{product}]: {got.get(product)!r} instead of {values}")
    return gaps
