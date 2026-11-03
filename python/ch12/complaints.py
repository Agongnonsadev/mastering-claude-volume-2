"""Chapter 12: the complaints chain, on the six test complaints, with their trace.

Run, from the python/ folder:  python -m ch12.complaints
Compare two drafting efforts:  python -m ch12.complaints --effort default --repetitions 2
                               python -m ch12.complaints --effort low --repetitions 2
"""

import argparse
import statistics
import uuid

import anthropic

from ch12.evaluate_router import load_messages
from comptoir import complaints
from comptoir.shop import Shop
from comptoir.trace import Trace


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", nargs="*")
    parser.add_argument("--effort", choices=["default", "low", "medium", "high"],
                        help="drafting effort; without this option, the module's; “default”: the model's")
    parser.add_argument("--repetitions", type=int, default=1)
    args = parser.parse_args()
    effort = {None: complaints.DRAFTING_EFFORT, "default": None}.get(args.effort, args.effort)
    client, shop, traces, results = anthropic.Anthropic(), Shop(":memory:"), [], []
    chosen = [m for m in load_messages() if m["expected"] == "complaint"]
    for _ in range(args.repetitions):
        for m in [m for m in chosen if not args.only or m["id"] in args.only]:
            trace = Trace()
            result = complaints.handle(client, m["message"], shop, uuid.uuid4().hex, trace, effort=effort)
            traces.append(trace)
            results.append(result)
            print(f"\n=== {m['id']} ===\nCustomer : {m['message']}\nComptoir : {result.reply}")
            print(f"Facts    : {result.facts}")
            print(f"To ask: {result.missing or 'nothing'}; versions: {result.attempts}; "
                  f"fallback text: {'yes' if result.fallback else 'no'}")
            for number, (version, critique) in enumerate(zip(result.versions, result.critiques), start=1):
                print(f"Version {number}, rejected: {version}")
                print(f"  Critique: {critique}")
            print(trace.show())
    cut_off = sum(c.startswith("answer stopped") for r in results for c in r.critiques)
    print(f"\nDrafting effort: {effort or 'model default'}; complaints: {len(results)}; "
          f"compliant at the 1st version: {sum(r.attempts == 1 and not r.fallback for r in results)}; "
          f"cut-off drafts: {cut_off}; fallback texts: {sum(r.fallback for r in results)}")
    print(f"Average cost: ${statistics.mean(t.cost for t in traces):.5f}; median duration: "
          f"{statistics.median(t.duration_ms for t in traces) / 1000:.1f} s; total cost: ${sum(t.cost for t in traces):.4f}; "
          f"requests recorded for Awa: {len(shop.requests())}")


if __name__ == "__main__":
    main()
