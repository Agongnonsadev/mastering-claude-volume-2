"""Chapter 7: extract the data of a purchase order (photo) or an invoice (PDF).

Run, from the python/ folder:
    python -m ch07.extract ch07/documents/order-01.jpg
    python -m ch07.extract ch07/documents/order-01.jpg --max-side 1000
    python -m ch07.extract ch07/documents/invoice-01.pdf --estimate      (free: counts the tokens)
"""

import argparse
import json

import anthropic

from comptoir.documents import document_block
from comptoir.extraction import (
    PurchaseOrder,
    check_invoice,
    check_order,
    extract,
    extraction_request,
    schema_for,
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("document")
    parser.add_argument("--max-side", type=int, help="shrink the image before sending it (in pixels)")
    parser.add_argument("--estimate", action="store_true", help="count the input tokens, without extracting")
    args = parser.parse_args()

    client = anthropic.Anthropic()
    schema = schema_for(args.document)
    blocks = [document_block(args.document, args.max_side)]

    if args.estimate:
        request = extraction_request(blocks, schema)
        count = client.messages.count_tokens(
            model=request["model"],
            system=request["system"],
            messages=request["messages"],
            output_config=request["output_config"],
        )
        print(f"Input tokens: {count.input_tokens}")
        return

    result = extract(client, blocks, schema)
    print(f"Cost: {result.cost}  (request {result.request_id})")
    if result.error:
        print(f"Failure: {result.error}")
        return
    print(json.dumps(result.data.model_dump(), ensure_ascii=False, indent=2))
    check = (check_order if schema is PurchaseOrder else check_invoice)(result.data)
    print(f"\nAmount calculated by the code: {check.computed_amount}")
    for anomaly in check.anomalies:
        print(f"  ⚠ {anomaly}")
    print("To be reviewed by a human." if check.to_review else "No anomaly: to be approved by a human.")


if __name__ == "__main__":
    main()
