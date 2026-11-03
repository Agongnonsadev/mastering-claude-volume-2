"""Chapter 7: Yao approves the orders extracted from the photos, one by one, before anything is recorded.

Nothing is recorded without a “y” typed by a human, even when no anomaly is
flagged: an order commits an amount, a delivery and Awa's word.

Run, from the python/ folder:  python -m ch07.approve_orders ch07/documents/order-*.jpg
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import anthropic

from comptoir.documents import image_block
from comptoir.extraction import PurchaseOrder, check_order, extract

REGISTER = Path("customer_data/orders.jsonl")  # customer data: outside Git


def summary(order: PurchaseOrder) -> str:
    lines = [f"{order.customer or '?'} — {order.neighborhood or '?'} — delivery: {order.delivery_date_read or '?'}"]
    for line in order.lines:
        lines.append(f"  {line.quantity if line.quantity is not None else '?'} × {line.product or line.read_label}")
    return "\n".join(lines)


def approve(client, path: Path, ask=input) -> dict | None:
    result = extract(client, [image_block(path)], PurchaseOrder)
    print(f"\n=== {path.name}  ({result.cost})")
    if result.error:
        print(f"Extraction failed: {result.error} — to be entered by hand.")
        return None
    check = check_order(result.data)
    print(summary(result.data))
    print(f"Amount calculated by the code: {check.computed_amount if check.computed_amount is not None else '?'} FCFA")
    for anomaly in check.anomalies:
        print(f"  ⚠ {anomaly}")
    if check.computed_amount is None:
        print("Amount impossible to calculate: correct the order with the customer before recording it.")
        return None
    if ask("Record this order? [y/N] ").strip().lower() != "y":
        print("Not recorded.")
        return None
    order = {
        "date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "document": path.name,
        "request": result.request_id,
        "order": result.data.model_dump(),
        "amount_fcfa": check.computed_amount,
        "accepted_anomalies": check.anomalies,
        "approved_by_a_human": True,
    }
    REGISTER.parent.mkdir(parents=True, exist_ok=True)
    with REGISTER.open("a", encoding="utf-8") as f:
        f.write(json.dumps(order, ensure_ascii=False) + "\n")
    print("Recorded.")
    return order


if __name__ == "__main__":
    client = anthropic.Anthropic()
    for name in sys.argv[1:]:
        approve(client, Path(name))
