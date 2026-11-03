"""Measure the accuracy of an extractor, field by field, classifying the errors (chapter 7).

Four outcomes for an expected field:
- “correct”: the right value;
- “missed”: null when a value was legible. Annoying, but visible: Yao checks;
- “invented”: a value when null was expected (illegible or missing). The most serious:
  it cannot be seen;
- “wrong”: another value than the right one. Serious too, unless a check catches it.
"""

import unicodedata
from collections import Counter
from dataclasses import dataclass

# The fields compared. Free text (remarks, labels) is not graded by the code:
# it is reread.
ORDER_FIELDS = ["customer", "neighborhood", "total_read"]
ORDER_LINE_FIELDS = ["product", "quantity", "unit_price_read"]
INVOICE_FIELDS = ["supplier", "number", "total_read", "currency"]
INVOICE_LINE_FIELDS = ["quantity", "unit_price", "amount"]


def _normalize(value):
    if isinstance(value, str):
        without_accents = unicodedata.normalize("NFKD", value.casefold())
        return " ".join("".join(c for c in without_accents if not unicodedata.combining(c)).split())
    return value


@dataclass(frozen=True)
class Gap:
    document: str
    field: str
    expected: object
    obtained: object

    @property
    def outcome(self) -> str:
        if _normalize(self.expected) == _normalize(self.obtained):
            return "correct"
        if self.obtained is None:
            return "missed"
        if self.expected is None:
            return "invented"
        return "wrong"


def compare(document: str, expected: dict, obtained: dict | None, invoice: bool = False) -> list[Gap]:
    """One gap per expected field. A failed extraction (obtained None) misses everything."""
    obtained = obtained or {}
    fields, line_fields = (INVOICE_FIELDS, INVOICE_LINE_FIELDS) if invoice else (ORDER_FIELDS, ORDER_LINE_FIELDS)
    gaps = [Gap(document, f, expected.get(f), obtained.get(f)) for f in fields]
    obtained_lines = obtained.get("lines", [])
    for rank, line in enumerate(expected.get("lines", [])):
        read = obtained_lines[rank] if rank < len(obtained_lines) else {}
        gaps.extend(Gap(document, f"lines.{rank}.{f}", line.get(f), read.get(f)) for f in line_fields)
    # A line read in excess is an invented line.
    for rank in range(len(expected.get("lines", [])), len(obtained_lines)):
        gaps.append(Gap(document, f"lines.{rank}", None, obtained_lines[rank]))
    return gaps


def summarize(gaps: list[Gap]) -> dict:
    outcomes = Counter(g.outcome for g in gaps)
    total = len(gaps)
    return {
        "fields": total,
        "accuracy": outcomes["correct"] / total if total else 0.0,
        **{outcome: outcomes[outcome] for outcome in ("correct", "missed", "invented", "wrong")},
    }
