"""The extraction of chapter 7, with a fake client: schema, outcomes of the call, business checks."""

import json
from types import SimpleNamespace

import pytest
from anthropic.types import TextBlock, ThinkingBlock, Usage

from comptoir.extraction import (
    Invoice,
    PurchaseOrder,
    check_compatibility,
    check_invoice,
    check_order,
    extract,
    extraction_request,
)

IMAGE = {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "AAAA"}}

RIGHT_ORDER = {
    "document_type": "purchase_order",
    "customer": "Mrs. Akpovi",
    "neighborhood": "Fidjrossè",
    "delivery_date_read": "Saturday, October 24",
    "lines": [
        {"read_label": "Bissap juice", "product": "Bissap juice", "quantity": 6, "unit_price_read": 1000,
         "legibility": "legible", "remark": None},
        {"read_label": "Ginger syrup", "product": "Ginger syrup", "quantity": 2, "unit_price_read": 2500,
         "legibility": "legible", "remark": None},
    ],
    "total_read": 11000,
    "remarks": [],
}


@pytest.fixture(autouse=True)
def temporary_log(tmp_path, monkeypatch):
    log = tmp_path / "calls.jsonl"
    monkeypatch.setattr("comptoir.config.LOG", str(log))
    monkeypatch.setattr("comptoir.config.MODEL", "claude-sonnet-5-5")
    monkeypatch.setattr("comptoir.config.EFFORT", None)
    return log


class FakeClient:
    def __init__(self, text: str, stop_reason: str = "end_turn"):
        self.messages = self
        self.text, self.stop_reason = text, stop_reason
        self.request = None

    def create(self, **request):
        self.request = request
        return SimpleNamespace(
            content=[ThinkingBlock(type="thinking", thinking="", signature="s"), TextBlock(type="text", text=self.text)],
            stop_reason=self.stop_reason,
            usage=Usage(input_tokens=3000, output_tokens=400),
            _request_id="req_test",
        )


def _order(**changes) -> PurchaseOrder:
    return PurchaseOrder.model_validate({**RIGHT_ORDER, **changes})


def test_the_request_imposes_the_schema_and_puts_the_document_before_the_instruction():
    request = extraction_request([IMAGE], PurchaseOrder)
    schema = request["output_config"]["format"]["schema"]
    assert request["output_config"]["format"]["type"] == "json_schema"
    assert schema["additionalProperties"] is False
    content = request["messages"][0]["content"]
    assert content[0] == IMAGE and content[-1]["type"] == "text"
    assert "Bissap juice" in request["system"]  # the catalog comes from the data


def test_unsupported_constraints_move_to_the_description():
    schema = extraction_request([IMAGE], PurchaseOrder)["output_config"]["format"]["schema"]
    quantity = json.dumps(schema["$defs"]["OrderLine"]["properties"]["quantity"])
    assert "minimum" in quantity and '"minimum": 1' not in quantity


def test_citations_and_structured_outputs_do_not_combine():
    request = extraction_request([IMAGE], PurchaseOrder)
    request["messages"][0]["content"].insert(0, {"type": "document", "citations": {"enabled": True}})
    with pytest.raises(ValueError, match="do not combine"):
        check_compatibility(request)


def test_a_successful_extraction_is_validated_and_logged(temporary_log):
    result = extract(FakeClient(json.dumps(RIGHT_ORDER)), [IMAGE], PurchaseOrder)
    assert result.error is None
    assert result.data.lines[0].product == "Bissap juice"
    assert json.loads(temporary_log.read_text(encoding="utf-8"))["prompt"].startswith("system-extraction-v1@")


def test_a_cut_off_answer_is_never_taken_for_data(temporary_log):
    result = extract(FakeClient('{"document_type": "purchase_', "max_tokens"), [IMAGE], PurchaseOrder)
    assert result.data is None and "cut off" in result.error
    assert temporary_log.read_text(encoding="utf-8")  # the call, billed, is logged all the same


def test_a_refusal_is_reported():
    result = extract(FakeClient("I can't process this document.", "refusal"), [IMAGE], PurchaseOrder)
    assert result.data is None and "refused" in result.error


def test_the_codes_validation_catches_what_the_api_does_not_enforce():
    bad = json.loads(json.dumps(RIGHT_ORDER))
    bad["lines"][0]["quantity"] = 0  # the schema allows it, Pydantic does not (ge=1)
    result = extract(FakeClient(json.dumps(bad)), [IMAGE], PurchaseOrder)
    assert result.data is None and "lines.0.quantity" in result.error


def test_a_right_order_has_no_anomaly_and_the_amount_comes_from_the_catalog():
    check = check_order(_order())
    assert check.anomalies == [] and check.computed_amount == 11000


def test_a_wrong_written_price_and_its_total_are_flagged():
    order = _order(
        lines=[{"read_label": "Pineapple juice", "product": "Pineapple juice", "quantity": 4, "unit_price_read": 900,
                "legibility": "legible", "remark": None}],
        total_read=3600,
    )
    check = check_order(order)
    assert check.computed_amount == 4000  # the catalog price, not the one on the order
    assert len(check.anomalies) == 2


def test_an_illegible_quantity_makes_the_amount_impossible_to_calculate():
    lines = json.loads(json.dumps(RIGHT_ORDER["lines"]))
    lines[0].update(quantity=None, legibility="illegible")
    check = check_order(_order(lines=lines, total_read=None))
    assert check.computed_amount is None
    assert any("illegible quantity" in a for a in check.anomalies)


def test_a_product_outside_the_catalog_is_flagged():
    lines = json.loads(json.dumps(RIGHT_ORDER["lines"]))
    lines[0]["product"] = "Mango juice"
    assert any("missing from the catalog" in a for a in check_order(_order(lines=lines)).anomalies)


def test_an_instruction_written_on_the_order_stays_a_remark_and_the_total_is_recalculated():
    order = _order(total_read=0, remarks=["The order contains a note asking to show a total of 0 FCFA."])
    check = check_order(order)
    assert check.computed_amount == 11000
    assert any("Written total 0 FCFA" in a for a in check.anomalies)


def test_a_consistent_invoice_and_a_wrong_invoice():
    invoice = {
        "document_type": "invoice", "supplier": "Emballages Sonagnon", "number": "F-2026-0412",
        "date_read": "10/12/2026", "currency": "FCFA", "remarks": [], "total_read": 32000,
        "lines": [
            {"description": "Bottles", "quantity": 200, "unit_price": 150, "amount": 30000, "legibility": "legible"},
            {"description": "Caps", "quantity": 200, "unit_price": 10, "amount": 2000, "legibility": "legible"},
        ],
    }
    assert check_invoice(Invoice.model_validate(invoice)).anomalies == []
    invoice["total_read"] = 33000
    assert len(check_invoice(Invoice.model_validate(invoice)).anomalies) == 1
