"""The shop: prices and fees calculated by the code, stock checked, an order created only once."""

import random
from datetime import datetime, timedelta, timezone

import pytest

from comptoir.shop import Shop, ShopRefusal

MORNING = datetime(2026, 10, 20, 8, 0, tzinfo=timezone.utc)  # 9 a.m. in Cotonou


class Clock:
    def __init__(self, instant):
        self.instant = instant

    def __call__(self):
        return self.instant


def shop(clock=None) -> Shop:
    return Shop(clock=clock or Clock(MORNING), rng=random.Random(42))


def test_the_initial_stock_and_an_unknown_product():
    s = shop()
    assert s.available("Bissap juice") == 40 and s.available("Soursop juice") == 0
    assert s.available("Mango juice") is None


def test_the_total_comes_from_the_catalog_and_delivery_is_free_from_5_bottles():
    summary = shop().prepare("c1", [{"product": "Bissap juice", "quantity": 6}], "Mrs. Hounkpè", "Akpakpa")
    assert summary["total_fcfa"] == 6000 and summary["delivery_fee"] == 0
    assert summary["planned_delivery"] == "today"  # order placed before noon, Cotonou time


def test_below_5_bottles_delivery_costs_500_fcfa_and_syrups_do_not_count():
    summary = shop().prepare("c1", [{"product": "Bissap juice", "quantity": 2},
                                    {"product": "Ginger syrup", "quantity": 3}], "Mr. Dossou", "Zogbo")
    assert summary["delivery_fee"] == 500 and summary["total_fcfa"] == 2000 + 7500 + 500


def test_in_the_afternoon_delivery_is_for_tomorrow():
    afternoon = shop(Clock(MORNING.replace(hour=12)))  # 1 p.m. in Cotonou
    assert afternoon.prepare("c1", [{"product": "Pineapple juice", "quantity": 5}], "A", "B")["planned_delivery"] == "tomorrow"


@pytest.mark.parametrize(
    "lines, reason",
    [
        ([{"product": "Mango juice", "quantity": 3}], "missing from the catalog"),
        ([{"product": "Pineapple juice", "quantity": 0}], "at least 1"),
        ([{"product": "Pineapple juice", "quantity": 15}], "Insufficient stock: 12"),
        ([{"product": "Bissap juice", "quantity": 40}, {"product": "Ginger juice", "quantity": 20}], "quote"),
        ([], "empty"),
    ],
)
def test_the_refusals_say_what_to_do(lines, reason):
    with pytest.raises(ShopRefusal, match=reason):
        shop().prepare("c1", lines, "A", "B")


def test_an_order_is_created_only_once_and_the_stock_goes_down():
    s = shop()
    code = s.prepare("c1", [{"product": "Bissap juice", "quantity": 6}], "A", "B")["confirmation_code"]
    first = s.confirm("c1", code)
    second = s.confirm("c1", code)  # the customer sends their “YES” again: nothing more
    assert first["order"] == second["order"] == "C-0001" and second["already_recorded"]
    assert len(s.orders()) == 1 and s.available("Bissap juice") == 34


def test_the_old_code_is_void_after_a_change_of_mind():
    s = shop()
    old = s.prepare("c1", [{"product": "Bissap juice", "quantity": 4}], "A", "B")["confirmation_code"]
    new = s.prepare("c1", [{"product": "Bissap juice", "quantity": 6}], "A", "B")["confirmation_code"]
    with pytest.raises(ShopRefusal, match="replaced"):
        s.confirm("c1", old)
    assert s.confirm("c1", new)["total_fcfa"] == 6000


def test_a_code_works_only_in_its_conversation():
    s = shop()
    code = s.prepare("c1", [{"product": "Bissap juice", "quantity": 6}], "A", "B")["confirmation_code"]
    with pytest.raises(ShopRefusal, match="no summary"):
        s.confirm("other-conversation", code)


def test_a_summary_expires():
    clock = Clock(MORNING)
    s = shop(clock)
    code = s.prepare("c1", [{"product": "Bissap juice", "quantity": 6}], "A", "B")["confirmation_code"]
    clock.instant = MORNING + timedelta(hours=3)
    with pytest.raises(ShopRefusal, match="expired"):
        s.confirm("c1", code)


def test_the_stock_is_checked_again_at_the_moment_of_creating():
    s = shop()
    code_c1 = s.prepare("c1", [{"product": "Pineapple juice", "quantity": 10}], "A", "B")["confirmation_code"]
    s.confirm("c2", s.prepare("c2", [{"product": "Pineapple juice", "quantity": 5}], "C", "D")["confirmation_code"])
    with pytest.raises(ShopRefusal, match="stock"):
        s.confirm("c1", code_c1)  # only 7 pineapples are left
