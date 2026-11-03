"""The Comptoir's tools: what Claude can ask for, and what the code really does (chapter 9).

Only three tools, each with a description that says what, when, and what it does not
do. Strict mode guarantees parameters that conform to the schema; the rules the
schema cannot carry (a quantity of at least 1, a catalog product) are
checked by the shop, which answers with an explicit error.

No tool creates an order: it is the customer who confirms, with a code that the code
checks (comptoir/orders.py).
"""

import json
from dataclasses import dataclass, field

from comptoir.shop import Shop, ShopRefusal


def _object(properties: dict, required: list[str]) -> dict:
    """A strict schema object: all the fields declared, no extra field."""
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


TOOLS = [
    {
        "name": "stock_check",
        "description": (
            "Gives the quantity available today for one or more products in the Délices d'Awa catalog. "
            "Use it when a customer wants to order, or asks whether a product is available. "
            "The names must be those of the catalog, exactly, for example “Bissap juice”. "
            "Returns neither prices nor delivery times: prices are in the catalog, delivery times in the terms."
        ),
        "strict": True,
        "input_schema": _object(
            {"products": {"type": "array", "items": {"type": "string"},
                          "description": "The exact names of the catalog products to check."}},
            ["products"],
        ),
    },
    {
        "name": "order_prepare",
        "description": (
            "Prepares the official summary of an order: checks the products and the stock, calculates the total "
            "with the catalog prices and the delivery fee. Does not create the order: it exists only after "
            "the customer's confirmation, which the system collects itself with a code. "
            "Call it when the customer has said what they want, under what name and to which Cotonou neighborhood to deliver it. "
            "If the customer changes their mind, call the tool again with the new order: the previous summary "
            "is canceled. If the tool returns an error (unknown product, insufficient stock, quote needed), "
            "explain it to the customer and offer a solution."
        ),
        "strict": True,
        "input_schema": _object(
            {
                "lines": {
                    "type": "array",
                    "description": "The products ordered, one line per product.",
                    "items": _object(
                        {"product": {"type": "string", "description": "The exact catalog name."},
                         "quantity": {"type": "integer", "description": "The number of bottles, at least 1."}},
                        ["product", "quantity"],
                    ),
                },
                "customer_name": {"type": "string", "description": "The name given by the customer for the delivery."},
                "neighborhood": {"type": "string", "description": "The delivery neighborhood, in Cotonou."},
            },
            ["lines", "customer_name", "neighborhood"],
        ),
    },
    {
        "name": "pass_to_awa",
        "description": (
            "Passes on to Awa a request only she can handle: discount or special price, complaint, quote "
            "(event, or more than 50 bottles), delivery outside Cotonou, or a question with no answer in the "
            "catalog and the terms. Awa reads these requests several times a day and answers the customer herself. "
            "After the call, tell the customer that their request has been passed on; promise neither a result, nor any delay "
            "other than those in the terms."
        ),
        "strict": True,
        "input_schema": _object(
            {
                "reason": {"type": "string", "enum": ["discount", "complaint", "quote", "out_of_zone", "other"]},
                "summary": {"type": "string",
                            "description": "The request in one or two sentences, so that Awa understands it without rereading the conversation."},
            },
            ["reason", "summary"],
        ),
    },
]

NAMES = {tool["name"] for tool in TOOLS}


@dataclass
class Execution:
    """What a tool turn produced, on top of the results sent back to Claude."""

    summary: dict | None = None
    passed_on: list[dict] = field(default_factory=list)
    calls: list[str] = field(default_factory=list)


class Tools:
    """Runs the tools for a given conversation, on a given shop."""

    def __init__(self, shop: Shop, conversation: str):
        self.shop = shop
        self.conversation = conversation

    def execute(self, call, execution: Execution) -> dict:
        """A tool_use block in, a tool_result block out. Never an exception toward the loop."""
        execution.calls.append(call.name)
        try:
            result = self._execute(call.name, call.input, execution)
            return {"type": "tool_result", "tool_use_id": call.id,
                    "content": json.dumps(result, ensure_ascii=False)}
        except ShopRefusal as refusal:
            # An instructive error: what is wrong, and what Claude must do now.
            return {"type": "tool_result", "tool_use_id": call.id, "content": str(refusal), "is_error": True}

    def _execute(self, name: str, tool_input: dict, execution: Execution) -> dict:
        if name == "stock_check":
            return {product: (self.shop.available(product) if product in self.shop.catalog
                              else "missing from the catalog") for product in tool_input["products"]}
        if name == "order_prepare":
            summary = self.shop.prepare(self.conversation, tool_input["lines"], tool_input["customer_name"],
                                        tool_input["neighborhood"])
            execution.summary = summary
            # Claude does not receive the code: the system itself shows the official summary.
            return {key: value for key, value in summary.items() if key not in ("confirmation_code", "to_tell_the_customer")}
        if name == "pass_to_awa":
            request = self.shop.pass_on(self.conversation, tool_input["reason"], tool_input["summary"])
            execution.passed_on.append(request)
            return request
        raise ShopRefusal(f"Unknown tool “{name}”. Available tools: {', '.join(sorted(NAMES))}.")
