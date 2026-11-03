"""Chapter 12: does the evaluator tick before or after writing its critique? 40 calls.

Two replies to a complaint: one compliant, the other promising a delivery. Each is
reviewed ten times by Claude Haiku 5.5 with the evaluation schema, the boxes first then the critique
first. A structured output follows the order of the schema's required properties: the box
“promises_something” is therefore filled in before, or after, the opinion. Cost: less than a cent.

Run, from the python/ folder:  python -m ch12.field_order
"""

import json
from concurrent.futures import ThreadPoolExecutor

import anthropic

from comptoir import complaints
from comptoir.costs import cost
from comptoir.log import log_call

MODEL = complaints.AUXILIARY_MODEL
COMPLIANT = ("We are truly sorry about this missing bottle in your delivery. Your complaint has been passed on to "
             "Awa, who will reply within 24 hours, in accordance with our terms of sale. "
             "Could you tell us which product was concerned?")
PROMISE = ("We are truly sorry about this missing bottle. Your complaint has been passed on to Awa, "
           "who will reply within 24 hours, and the bottle will be delivered to you as early as tomorrow.")


def schema(critique_first: bool) -> dict:
    """The Comptoir's schema (critique first), or its first version (boxes first)."""
    s = json.loads(json.dumps(complaints.EVALUATION_SCHEMA))
    if not critique_first:
        properties = s["properties"]
        s["properties"] = {**{k: v for k, v in properties.items() if k != "critique"}, "critique": properties["critique"]}
        s["required"] = [k for k in s["required"] if k != "critique"] + ["critique"]
    return s


def review(client, text: str, critique_first: bool) -> tuple[dict, float]:
    response = client.messages.create(model=MODEL, max_tokens=600, system=complaints.EVALUATION_SYSTEM,
                                      messages=[{"role": "user", "content": f"<answer>{text}</answer>"}],
                                      output_config={"format": {"type": "json_schema", "schema": schema(critique_first)}})
    price = cost(MODEL, response.usage)
    log_call(response._request_id, MODEL, price, prompt="ch12-field-order", stop_reason=response.stop_reason)
    return json.loads("".join(b.text for b in response.content if b.type == "text")), price.dollars


def main() -> None:
    client, total = anthropic.Anthropic(), 0.0
    for name, text in [("compliant reply", COMPLIANT), ("promising reply", PROMISE)]:
        for critique_first in (False, True):
            with ThreadPoolExecutor(max_workers=5) as executor:
                results = list(executor.map(lambda _: review(client, text, critique_first), range(10)))
            total += sum(price for _, price in results)
            promises = sum(j["promises_something"] for j, _ in results)
            order = "critique first" if critique_first else "boxes first"
            print(f"{name:20} {order:17}: “promises” ticked {promises} times out of 10; "
                  f"first field returned: {next(iter(results[0][0]))}")
            print(f"{'':20} example of critique: {results[0][0]['critique'][:150]}")
    print(f"\nCost: ${total:.4f}")


if __name__ == "__main__":
    main()
