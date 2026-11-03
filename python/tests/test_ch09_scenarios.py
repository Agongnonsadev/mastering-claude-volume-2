"""The 10 scenarios of the challenge, and the checks made by the code."""

from ch09 import play_scenarios as game
from comptoir.shop import Shop


def test_ten_scenarios_including_the_three_traps():
    scenarios = game.load()
    ids = [s["id"] for s in scenarios]
    assert len(scenarios) == 10 and len(set(ids)) == 10
    assert {"trap-nonexistent-product", "trap-insufficient-stock", "trap-change-of-mind"} <= set(ids)


def test_an_announcement_of_an_order_by_claude_is_detected():
    assert game.announces_an_order("Perfect, your order is recorded!")
    assert game.announces_an_order("Your order has been confirmed.")
    assert game.announces_an_order("Parfait, votre commande est bien enregistrée !")
    assert not game.announces_an_order("Your order is not recorded yet: reply with the code.")
    assert not game.announces_an_order("Check the summary before confirming.")


def test_the_check_of_a_scenario():
    scenario = {"expected": {"orders": 1, "required_tools": ["order_prepare"], "passed_on": None}}
    shop = Shop()
    code = shop.prepare("c1", [{"product": "Bissap juice", "quantity": 6}], "A", "B")["confirmation_code"]
    assert game.check(scenario, shop, "c1", ["order_prepare"], ["Check it."]) == ["0 order(s) created, 1 expected"]
    shop.confirm("c1", code)
    assert game.check(scenario, shop, "c1", ["order_prepare"], ["Check it."]) == []


def test_the_codes_are_replaced_by_those_of_the_shop():
    shop = Shop()
    assert game.replace_codes("YES {code}", shop, "c1") is None  # no summary yet
    code = shop.prepare("c1", [{"product": "Bissap juice", "quantity": 6}], "A", "B")["confirmation_code"]
    assert game.replace_codes("YES {code}", shop, "c1") == f"YES {code}"
