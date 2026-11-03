"""The week's sales: a fixed export, and our reference calculation to check the report."""

import csv
import io

from ch10 import make_sales as maker
from comptoir.sales import compare, read, totals


def test_the_export_is_in_the_repository_and_does_not_change():
    lines = read(maker.SALES)
    expected = maker.make()
    assert len(lines) == len(expected) == 77
    assert [l["order"] for l in lines] == [e[1] for e in expected]


def test_the_reference_totals():
    t = totals(read(maker.SALES))
    assert t["revenue_fcfa"] == 394_000 and t["orders"] == 37
    assert t["average_basket_fcfa"] == 10_649
    assert sum(t["by_day"].values()) == sum(t["by_neighborhood"].values()) == t["revenue_fcfa"]
    assert sum(p["amount_fcfa"] for p in t["by_product"].values()) == t["revenue_fcfa"]


def test_the_comparison_finds_a_gap_and_tolerates_a_rounding():
    t = totals(read(maker.SALES))
    assert compare(t, t) == []
    assert compare({**t, "average_basket_fcfa": t["average_basket_fcfa"] + 1}, t) == []  # different rounding
    wrong = {**t, "by_day": {**t["by_day"], "2026-10-12": 1}}
    assert compare(wrong, t) == [f"by_day[2026-10-12]: 1 instead of {t['by_day']['2026-10-12']}"]


def test_the_calculation_on_a_small_export():
    text = "date,order,product,quantity,unit_price_fcfa,neighborhood,channel\n" \
           "2026-10-12,C-1,Bissap juice,2,1000,Zogbo,whatsapp\n2026-10-12,C-1,Bissap syrup,1,2500,Zogbo,whatsapp\n"
    lines = [{**l, "quantity": int(l["quantity"]), "unit_price_fcfa": int(l["unit_price_fcfa"])}
             for l in csv.DictReader(io.StringIO(text))]
    assert totals(lines)["revenue_fcfa"] == 4500 and totals(lines)["orders"] == 1
