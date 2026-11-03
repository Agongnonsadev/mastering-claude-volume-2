"""Chapter 12: the 30 messages, with and without the router, each in a new conversation.

- direct: everything goes to the Comptoir of chapter 11 (Claude Sonnet 5.5, tools, base, one-hour cache);
- routed: the router chooses the service, each step is traced.

Run, from the python/ folder:  python -m ch12.routed_comptoir --max-budget 1
"""

import argparse
import csv
import json
import statistics
import time
import uuid
from pathlib import Path

from ch12.evaluate_router import load_messages
from comptoir import config
from comptoir.budget import Budget
from comptoir.call import make_client
from comptoir.knowledge import load_knowledge
from comptoir.orders import ComptoirOrders
from comptoir.routing import RoutedComptoir
from comptoir.shop import Shop

FOLDER = Path(__file__).parent


def log_cost(since: int) -> tuple[float, int]:
    with open(config.LOG, encoding="utf-8") as f:
        lines = [json.loads(l) for l in f][since:]
    calls = [l for l in lines if "request" in l]
    return sum(l["cost_dollars"] for l in calls), len(calls)


def log_size() -> int:
    try:
        with open(config.LOG, encoding="utf-8") as f:
            return sum(1 for _ in f)
    except FileNotFoundError:
        return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--modes", nargs="+", choices=["direct", "routed"], default=["direct", "routed"])
    parser.add_argument("--max-budget", type=float, default=1.0)
    parser.add_argument("--traces", nargs="*", default=["godomey", "discomfort", "six-bissap"])
    args = parser.parse_args()

    client, base, lines, spent = make_client(), load_knowledge(), [], 0.0
    for mode in args.modes:
        for m in load_messages():
            if spent >= args.max_budget:
                raise SystemExit(f"Budget of ${args.max_budget} reached: stopping.")
            shop, conversation = Shop(":memory:"), uuid.uuid4().hex
            before, start = log_size(), time.perf_counter()
            if mode == "direct":
                comptoir = ComptoirOrders(client, shop, Budget(":memory:"), conversation, prompt_version="v3",
                                          knowledge=base, cache="1h")
                text, category, trace = comptoir.answer(m["message"]).text, "—", None
            else:
                # The Comptoir of this chapter: Claude Sonnet 5.5 (chapter 17 replaced it with Haiku 5.5).
                r = RoutedComptoir(client, shop, Budget(":memory:"), conversation, base,
                                   comptoir_model=config.MODEL).answer(m["message"])
                text, category, trace = r.text, r.category, r.trace
            duration = time.perf_counter() - start
            cost, calls = log_cost(before)
            spent += cost
            lines.append({"mode": mode, "id": m["id"], "expected": m["expected"], "category": category,
                          "calls": calls, "cost_dollars": round(cost, 6), "duration_s": round(duration, 2),
                          "requests_for_awa": len(shop.requests()), "answer": text})
            if trace and m["id"] in args.traces:
                print(f"\n--- {m['id']}: {m['message']}\n{text}\n{trace.show()}")

    output = FOLDER / "results" / "comptoir.csv"
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():  # rerunning a single mode keeps the lines of the other
        with output.open(encoding="utf-8", newline="") as f:
            lines = [l for l in csv.DictReader(f) if l["mode"] not in args.modes] + lines
    with output.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(lines[0]))
        writer.writeheader()
        writer.writerows(lines)

    print(f"\n{'mode':9} {'expected category':20} {'messages':>8} {'calls':>7} {'avg cost':>11} {'median dur.':>11}")
    for mode in args.modes:
        for expected in ("information", "order", "complaint", "other", None):
            g = [l for l in lines if l["mode"] == mode and (expected is None or l["expected"] == expected)]
            print(f"{mode:9} {expected or 'ALL':20} {len(g):>8} {sum(l['calls'] for l in g):>7} "
                  f"{statistics.mean(l['cost_dollars'] for l in g):>11.5f} {statistics.median(l['duration_s'] for l in g):>10.1f}s")
    print(f"\nSpent: ${spent:.4f}; answers to review: {output}")


if __name__ == "__main__":
    main()
