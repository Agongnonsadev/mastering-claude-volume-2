"""The human approval of chapter 7: nothing is recorded without a “y” typed by Yao."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from anthropic.types import TextBlock, Usage

from ch07 import approve_orders

DOCUMENTS = Path(__file__).parent.parent / "ch07" / "documents"

ORDER = {
    "document_type": "purchase_order", "customer": "Mrs. Akpovi", "neighborhood": "Fidjrossè",
    "delivery_date_read": "Saturday, October 24", "total_read": 6000, "remarks": [],
    "lines": [{"read_label": "Bissap", "product": "Bissap juice", "quantity": 6, "unit_price_read": 1000,
               "legibility": "legible", "remark": None}],
}


class FakeClient:
    def __init__(self, order):
        self.messages = self
        self.order = order

    def create(self, **request):
        return SimpleNamespace(
            content=[TextBlock(type="text", text=json.dumps(self.order))],
            stop_reason="end_turn",
            usage=Usage(input_tokens=3000, output_tokens=300),
            _request_id="req_test",
        )


@pytest.fixture(autouse=True)
def temporary_files(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.LOG", str(tmp_path / "calls.jsonl"))
    monkeypatch.setattr("comptoir.config.MODEL", "claude-sonnet-5-5")
    register = tmp_path / "orders.jsonl"
    monkeypatch.setattr(approve_orders, "REGISTER", register)
    return register


def test_without_agreement_nothing_is_recorded(temporary_files):
    order = approve_orders.approve(FakeClient(ORDER), DOCUMENTS / "order-01.jpg", ask=lambda _: "")
    assert order is None and not temporary_files.exists()


def test_with_agreement_the_order_and_its_calculated_amount_are_recorded(temporary_files):
    order = approve_orders.approve(FakeClient(ORDER), DOCUMENTS / "order-01.jpg", ask=lambda _: "y")
    assert order["amount_fcfa"] == 6000 and order["approved_by_a_human"]
    assert json.loads(temporary_files.read_text(encoding="utf-8"))["document"] == "order-01.jpg"


def test_an_amount_impossible_to_calculate_is_not_even_proposed(temporary_files):
    illegible = json.loads(json.dumps(ORDER))
    illegible["lines"][0].update(quantity=None, legibility="illegible")
    questions_asked = []
    order = approve_orders.approve(
        FakeClient(illegible), DOCUMENTS / "order-03.jpg", ask=lambda q: questions_asked.append(q) or "y"
    )
    assert order is None and questions_asked == [] and not temporary_files.exists()
