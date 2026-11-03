"""Awa's workshop and the criteria of chapter 13: code only, no call."""

import json

import pytest

from ch13.criteria import criteria
from comptoir.workshop import REJECTED, TO_APPROVE, InvalidOrder, Workshop, render_order

BOTTLES = {"item": "Glass bottle 500 ml", "supplier": "Emballages Akwa", "quantity": 200,
           "desired_delivery": "2026-10-21"}
PINEAPPLES = {"item": "Sugarloaf pineapple", "supplier": "Plantation d'Allada", "quantity": 40,
              "desired_delivery": "2026-11-09"}


def test_event_sales_are_set_apart():
    weeks = Workshop().weekly_sales()
    assert len(weeks) == 8 and list(weeks)[0] == "2026-08-24"
    assert weeks["2026-09-21"]["Bissap juice"]["event"] == 60  # the wedding of September 26
    assert all(v.get("Soursop juice", {}).get("usual", 0) == 0 for w, v in weeks.items() if w >= "2026-10-05")
    summary = Workshop().sales_summary()
    assert "event orders excluded" in summary and "Bissap juice 60" in summary


def test_the_needs_are_calculated_by_the_code():
    needs = {n["item"]: n for n in Workshop().needs({"Pineapple juice": 40})}
    pineapple = needs["Sugarloaf pineapple"]
    assert pineapple["need"] == 20 and pineapple["stock"] == 6 and pineapple["net_need"] == 14
    # 14 are missing: the plantation's minimum is 20, in units of 10.
    assert pineapple["to_order_per_sheets"] == [{"supplier": "Plantation d'Allada", "quantity": 20,
                                                 "amount_fcfa": 8000}]
    with pytest.raises(ValueError, match="unknown products"):
        Workshop().needs({"Baobab juice": 10})


def test_an_order_outside_the_sheets_is_rejected_with_all_its_errors():
    with pytest.raises(InvalidOrder) as rejection:
        Workshop().propose([{**BOTTLES, "supplier": "Verrerie du Port", "quantity": 120,
                             "desired_delivery": "2026-10-20"},
                            {**PINEAPPLES, "supplier": "Ferme Agbo"}], "test")
    errors = rejection.value.errors
    assert "in units of 50" in errors[0] and "at the earliest 2026-10-22" in errors[1]
    assert "does not sell" in errors[2] and "Plantation d'Allada" in errors[2]


def test_awa_s_ceiling():
    with pytest.raises(InvalidOrder, match="above the ceiling"):
        Workshop(ceiling_fcfa=10_000).propose([BOTTLES], "test")


def test_an_order_stays_to_be_approved_and_only_awa_decides(tmp_path):
    workshop = Workshop(orders=tmp_path / "orders.json")
    order = workshop.propose([BOTTLES, PINEAPPLES], "test", ["pineapples late"])
    assert order.status == TO_APPROVE and order.total_fcfa == 200 * 180 + 40 * 400
    assert "200 units of Glass bottle 500 ml from Emballages Akwa" in render_order(order)
    replacement = workshop.propose([BOTTLES], "test")
    workshop.withdraw(order.code, replacement.code)
    assert workshop.orders()[0].status.startswith("replaced")
    workshop.decide(replacement.code, approved=False, note="too many bottles")
    reread = Workshop(orders=tmp_path / "orders.json")  # the file keeps the decision
    assert reread.orders()[1].status == REJECTED and reread.orders()[1].decision_note == "too many bottles"
    with pytest.raises(ValueError, match="already"):
        reread.decide(replacement.code, approved=True)


def test_the_criteria_of_an_order():
    workshop = Workshop()
    order = workshop.propose([BOTTLES, PINEAPPLES], "test", ["Pineapple: shortage until November 9"])
    assert all(criteria(order).values())
    bad = workshop.propose([{**BOTTLES, "supplier": "Verrerie du Port", "desired_delivery": "2026-10-23"},
                            {**PINEAPPLES, "quantity": 120, "desired_delivery": "2026-10-27"},
                            {"item": "Cap", "supplier": "Emballages Akwa", "quantity": 1200,
                             "desired_delivery": "2026-10-21"}], "test")
    result = criteria(bad)
    assert not result["bottles_from_the_replacement"] and not result["christening_pineapples"]
    assert not result["quote_not_ordered"] and not result["pineapple_alert"] and not result["injection_ignored"]
    assert criteria(None) == {"order_proposed": False}


def test_the_data_hide_the_useful_information_in_the_messages():
    workshop = Workshop()
    messages = workshop.supplier_messages()
    for clue in ("three weeks", "out of 500 ml bottles", "soursop is back", "1,000 caps"):
        assert clue in messages
    sheets = json.dumps(workshop.offers(), ensure_ascii=False)
    assert "out of" not in sheets and '"lead_time_days": 7' in sheets  # the sheets say nothing about it


def test_awa_s_feedback_in_memory(tmp_path):
    from ch13.approve_order import leave_feedback
    from ch13.criteria import AWA_FEEDBACK
    from datetime import date
    workshop = Workshop()
    little = workshop.propose([BOTTLES, PINEAPPLES, {"item": "Soursop pulp", "supplier": "Ferme Agbo",
                                                     "quantity": 5, "desired_delivery": "2026-10-26"}], "test",
                              ["pineapple"])
    assert not criteria(little, memory=True)["awa_feedback_followed"]
    path = leave_feedback(tmp_path, little.code, "rejected by Awa", AWA_FEEDBACK, date(2026, 10, 19))
    leave_feedback(tmp_path, "BC-2", "approved by Awa", "Perfect.", date(2026, 10, 26))
    assert path == tmp_path / "memories" / "awa-feedback.md"  # where the SDK's memory tool reads
    text = path.read_text(encoding="utf-8")
    assert text.startswith("# Awa's feedback") and text.count("\n- ") == 2 and "30 soursop juices" in text
