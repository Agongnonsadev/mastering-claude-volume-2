"""The sample documents of chapter 7: present, well formed, consistent with the checks."""

import json
import re
from pathlib import Path

from PIL import Image

from ch07 import make_samples as samples
from comptoir.documents import expected_tokens
from comptoir.extraction import PurchaseOrder, check_order

FOLDER = Path(__file__).parent.parent / "ch07" / "documents"


def test_the_documents_and_the_expected_values_are_in_the_repository():
    expected = json.loads((FOLDER / "expected.json").read_text(encoding="utf-8"))
    assert expected == samples.expected()  # the script and the file say the same thing
    for name in expected:
        assert (FOLDER / name).exists()
    assert (FOLDER / "supplier-terms.pdf").exists()


def test_a_sample_photo_costs_a_few_thousand_tokens():
    with Image.open(FOLDER / "order-01.jpg") as image:
        assert 2000 < expected_tokens(*image.size, "claude-sonnet-5-5") <= 4784


def test_the_text_pdf_is_well_formed():
    content = (FOLDER / "supplier-terms.pdf").read_bytes()
    assert content.startswith(b"%PDF-1.4") and content.rstrip().endswith(b"%%EOF")
    # Each entry of the xref table points to the start of its object.
    xref = int(re.search(rb"startxref\n(\d+)", content).group(1))
    entries = re.findall(rb"(\d{10}) 00000 n", content[xref:])
    for number, position in enumerate(entries, start=1):
        assert content[int(position):].startswith(b"%d 0 obj" % number)
    assert b"/Count 2" in content  # two pages, for citations per page


def _expected_order(name: str) -> PurchaseOrder:
    """The order as a right reading would return it, from the script's data."""
    order = next(o for o in samples.ORDERS if o["file"] == name)
    return PurchaseOrder(
        document_type="purchase_order",
        customer=order["customer"],
        neighborhood=order["neighborhood"],
        delivery_date_read=order["date"],
        lines=[
            {"read_label": label, "product": product, "quantity": quantity, "unit_price_read": price,
             "legibility": "illegible" if quantity is None else "legible", "remark": None}
            for label, product, quantity, price in order["lines"]
        ],
        total_read=order["total"],
        remarks=[],
    )


def test_each_sample_order_raises_the_intended_problem():
    assert check_order(_expected_order("order-01.jpg")).anomalies == []
    assert len(check_order(_expected_order("order-02.jpg")).anomalies) == 2  # price and total
    assert check_order(_expected_order("order-03.jpg")).computed_amount is None  # stained quantity
    assert check_order(_expected_order("order-04.jpg")).computed_amount == 5000
