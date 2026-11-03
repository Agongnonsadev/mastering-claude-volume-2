"""Chapter 7: measure the extractor's accuracy on a set of documents whose answer is known.

The expected values are in ch07/documents/expected.json. For your own set,
write them before the first trial, and set the accuracy target before measuring.

Run, from the python/ folder:
    python -m ch07.measure_accuracy --repetitions 3 --max-budget 0.5
    python -m ch07.measure_accuracy --max-side 1000 --repetitions 3 --max-budget 0.5
"""

import argparse
import json
from pathlib import Path

import anthropic

from comptoir.accuracy import compare, summarize
from comptoir.documents import document_block
from comptoir.extraction import Invoice, extract, schema_for

DOCUMENTS = Path(__file__).parent / "documents"


def measure(client, expected: dict, repetitions: int, max_budget: float, max_side: int | None = None):
    gaps, spent, failures = [], 0.0, []
    for _ in range(repetitions):
        for name, expected_values in expected.items():
            if spent >= max_budget:
                print(f"Budget reached (${spent:.4f}): stopping.")
                return gaps, spent, failures
            schema = schema_for(name)
            result = extract(client, [document_block(DOCUMENTS / name, max_side)], schema)
            spent += result.cost.dollars
            if result.error:
                failures.append((name, result.error))
            obtained = result.data.model_dump() if result.data else None
            gaps.extend(compare(name, expected_values, obtained, invoice=schema is Invoice))
    return gaps, spent, failures


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--max-budget", type=float, default=0.5, help="in dollars")
    parser.add_argument("--max-side", type=int)
    args = parser.parse_args()

    expected = json.loads((DOCUMENTS / "expected.json").read_text(encoding="utf-8"))
    gaps, spent, failures = measure(anthropic.Anthropic(), expected, args.repetitions, args.max_budget, args.max_side)
    summary = summarize(gaps)
    print(f"\nFields graded: {summary['fields']}  —  accuracy: {summary['accuracy']:.1%}  —  spent: ${spent:.4f}")
    print(f"correct {summary['correct']}, missed {summary['missed']}, invented {summary['invented']}, wrong {summary['wrong']}")
    for g in gaps:
        if g.outcome != "correct":
            print(f"  {g.outcome:9} {g.document} {g.field}: expected {g.expected!r}, obtained {g.obtained!r}")
    for name, error in failures:
        print(f"  failure   {name}: {error}")


if __name__ == "__main__":
    main()
