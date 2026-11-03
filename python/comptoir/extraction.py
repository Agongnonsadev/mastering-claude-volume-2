"""Turn a photo of a purchase order or an invoice into validated data (chapter 7).

Three layers, none of which trusts the previous one:
1. the schema, imposed on Claude by structured outputs: the form is guaranteed;
2. Pydantic validation, by the code: the constraints the API does not check;
3. business checks, by the code: catalog prices, totals, doubtful lines.
Then a human approves, before anything is recorded.
"""

from dataclasses import dataclass, field
from pathlib import Path
from string import Template
from typing import Literal

from anthropic import transform_schema
from pydantic import BaseModel, Field, ValidationError

from comptoir import config
from comptoir.costs import Cost, cost
from comptoir.log import log_call
from comptoir.prompt import FOLDER, SystemPrompt, load_data, render_catalog

MAX_TOKENS = 4000  # thinking included: a twenty-line order must fit without being cut off

Legibility = Literal["legible", "doubtful", "illegible"]


# --- The schemas ------------------------------------------------------------------------
# The descriptions are part of the prompt: Claude reads them. Constraints such as ge=1, which
# the API does not enforce, go into the description (the SDK takes care of it); Pydantic checks them.


class OrderLine(BaseModel):
    read_label: str = Field(description="The product as written on the order, copied without correction.")
    product: str | None = Field(
        description="The exact catalog name, only if the match is certain; otherwise null."
    )
    quantity: int | None = Field(ge=1, description="The number of bottles; null if illegible or missing.")
    unit_price_read: int | None = Field(
        description="The unit price written on the order, in FCFA; null if it is not written or illegible."
    )
    legibility: Legibility
    remark: str | None = Field(description="What is wrong with this line; null otherwise.")


class PurchaseOrder(BaseModel):
    document_type: Literal["purchase_order", "other"]
    customer: str | None = Field(description="The customer's name as it is written; null if there is none.")
    neighborhood: str | None = Field(description="The delivery neighborhood or address; null if there is none.")
    delivery_date_read: str | None = Field(description="The delivery date as it is written; null otherwise.")
    lines: list[OrderLine]
    total_read: int | None = Field(description="The total written on the order, in FCFA, copied without calculation; null otherwise.")
    remarks: list[str] = Field(description="The illegible, ambiguous or unusual passages of the document.")


class InvoiceLine(BaseModel):
    description: str = Field(description="The description as it is written.")
    quantity: int | None = Field(ge=1, description="The quantity invoiced; null if illegible.")
    unit_price: int | None = Field(description="The written unit price, in the invoice's currency; null otherwise.")
    amount: int | None = Field(description="The amount of the line as it is written; null otherwise.")
    legibility: Legibility


class Invoice(BaseModel):
    document_type: Literal["invoice", "other"]
    supplier: str | None = Field(description="The supplier's name; null if it is illegible.")
    number: str | None = Field(description="The invoice number; null if there is none.")
    date_read: str | None = Field(description="The invoice date as it is written; null otherwise.")
    lines: list[InvoiceLine]
    total_read: int | None = Field(description="The total to pay written on the invoice, without calculation; null otherwise.")
    currency: str | None = Field(description="The currency written on the invoice (for example FCFA); null otherwise.")
    remarks: list[str] = Field(description="The illegible, ambiguous or unusual passages of the document.")


INSTRUCTIONS = {
    PurchaseOrder: "Here is the photo of a purchase order received on WhatsApp. Extract its data.",
    Invoice: "Here is a supplier invoice. Extract its data.",
}


# --- The request --------------------------------------------------------------------------


def extraction_prompt(version: str = "v1", data: dict | None = None) -> SystemPrompt:
    template = Template((FOLDER / "prompts" / f"extraction_{version}.md").read_text(encoding="utf-8"))
    text = template.substitute(catalog=render_catalog(data or load_data()))
    return SystemPrompt(text.strip(), f"extraction-{version}")


def check_compatibility(request: dict) -> None:
    """Citations and structured outputs do not combine: the API would answer with a 400 error."""
    imposed_format = "format" in request.get("output_config", {})
    citations = any(
        isinstance(block, dict) and block.get("citations", {}).get("enabled")
        for message in request["messages"]
        if isinstance(message["content"], list)
        for block in message["content"]
    )
    if imposed_format and citations:
        raise ValueError("Citations and structured outputs do not combine: choose one or the other.")


def extraction_request(blocks: list[dict], schema: type[BaseModel], prompt: SystemPrompt | None = None) -> dict:
    prompt = prompt or extraction_prompt()
    output_config = {"format": {"type": "json_schema", "schema": transform_schema(schema)}}
    if config.EFFORT:
        output_config["effort"] = config.EFFORT
    request = {
        "model": config.MODEL,
        "max_tokens": MAX_TOKENS,
        "system": prompt.text,
        # The document first, the instruction next: that is the recommended order.
        "messages": [{"role": "user", "content": [*blocks, {"type": "text", "text": INSTRUCTIONS[schema]}]}],
        "output_config": output_config,
    }
    check_compatibility(request)
    return request


# --- The call and its outcomes ---------------------------------------------------------------


@dataclass
class Extraction:
    data: BaseModel | None
    error: str | None
    stop_reason: str | None
    cost: Cost
    request_id: str | None


def extract(client, blocks: list[dict], schema: type[BaseModel], prompt: SystemPrompt | None = None) -> Extraction:
    """Calls Claude and returns validated data, or an explicit error. Never doubtful data
    without saying so.

    client.messages.parse() is not used: in case of a refusal or a cut-off answer, it raises
    an exception before returning the message, and the call, billed all the same, escapes the log.
    """
    prompt = prompt or extraction_prompt()
    request = extraction_request(blocks, schema, prompt)
    message = client.messages.create(**request)
    price = cost(request["model"], message.usage)
    log_call(message._request_id, request["model"], price, prompt=prompt.id)

    def failure(reason: str) -> Extraction:
        return Extraction(None, reason, message.stop_reason, price, message._request_id)

    # The schema is guaranteed only if the answer went through to the end normally.
    if message.stop_reason == "refusal":
        return failure("Claude refused to process this document.")
    if message.stop_reason == "max_tokens":
        return failure("Answer cut off before the end: raise max_tokens or split the document.")
    text = "".join(b.text for b in message.content if b.type == "text")
    try:
        return Extraction(schema.model_validate_json(text), None, message.stop_reason, price, message._request_id)
    except ValidationError as error:
        fields = ", ".join(".".join(str(p) for p in e["loc"]) for e in error.errors())
        return failure(f"Answer rejected by the code's validation ({fields}).")


# --- The business checks ----------------------------------------------------------------


@dataclass
class Check:
    anomalies: list[str] = field(default_factory=list)
    computed_amount: int | None = None  # calculated by the code, never by the model

    @property
    def to_review(self) -> bool:
        return bool(self.anomalies)


def check_order(order: PurchaseOrder, data: dict | None = None) -> Check:
    prices = {p["name"]: p["price_fcfa"] for p in (data or load_data())["products"]}
    check = Check()
    if order.document_type != "purchase_order":
        check.anomalies.append("This document is not a purchase order.")
        return check
    if not order.lines:
        check.anomalies.append("No order line read.")

    complete = bool(order.lines)
    total = 0
    for rank, line in enumerate(order.lines, start=1):
        name = f"Line {rank} (“{line.read_label}”)"
        if line.legibility != "legible":
            check.anomalies.append(f"{name}: {line.legibility} reading.")
        if line.product is None or line.product not in prices:
            check.anomalies.append(f"{name}: product missing from the catalog or uncertain.")
            complete = False
            continue
        if line.quantity is None:
            check.anomalies.append(f"{name}: illegible quantity.")
            complete = False
            continue
        if line.unit_price_read is not None and line.unit_price_read != prices[line.product]:
            check.anomalies.append(
                f"{name}: written price {line.unit_price_read} FCFA, catalog {prices[line.product]} FCFA."
            )
        total += line.quantity * prices[line.product]

    if complete:
        check.computed_amount = total
        if order.total_read is not None and order.total_read != total:
            check.anomalies.append(f"Written total {order.total_read} FCFA, calculated total {total} FCFA.")
    check.anomalies.extend(f"Reading remark: {r}" for r in order.remarks)
    return check


def check_invoice(invoice: Invoice) -> Check:
    check = Check()
    if invoice.document_type != "invoice":
        check.anomalies.append("This document is not an invoice.")
        return check
    if invoice.currency and invoice.currency.upper() not in ("FCFA", "XOF", "F CFA"):
        check.anomalies.append(f"Unusual currency: {invoice.currency}.")

    complete = bool(invoice.lines)
    total = 0
    for rank, line in enumerate(invoice.lines, start=1):
        name = f"Line {rank} (“{line.description}”)"
        if line.legibility != "legible":
            check.anomalies.append(f"{name}: {line.legibility} reading.")
        if line.quantity is None or line.unit_price is None:
            check.anomalies.append(f"{name}: illegible quantity or price.")
            complete = False
            continue
        expected = line.quantity * line.unit_price
        if line.amount is not None and line.amount != expected:
            check.anomalies.append(f"{name}: written amount {line.amount}, calculated {expected}.")
        total += expected

    if complete:
        check.computed_amount = total
        if invoice.total_read is not None and invoice.total_read != total:
            check.anomalies.append(f"Written total {invoice.total_read}, calculated total {total}.")
    check.anomalies.extend(f"Reading remark: {r}" for r in invoice.remarks)
    return check


def schema_for(path: str | Path) -> type[BaseModel]:
    """The Comptoir sorts its samples by name: order-*.jpg, invoice-*.pdf."""
    return Invoice if Path(path).name.startswith("invoice") else PurchaseOrder
