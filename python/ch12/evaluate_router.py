"""Chapter 12: does the router classify well? 30 messages, several settings, several passes.

For each setting: the success, the missed complaints (the only forbidden failure), the cost
and the duration per message. The vote of three is computed from the three passes, without an extra call.

Run, from the python/ folder:  python -m ch12.evaluate_router --repetitions 3 --max-budget 0.5
"""

import argparse
import csv
import json
import statistics
import time
from collections import Counter
from pathlib import Path

import anthropic

from comptoir.router import Decision, RoutingImpossible, by_code, classify, vote

FOLDER = Path(__file__).parent
SETTINGS = {
    "haiku": {"model": "claude-haiku-5-5"},
    "haiku-no-thinking": {"model": "claude-haiku-5-5", "no_thinking": True},
    "sonnet-low": {"model": "claude-sonnet-5-5", "effort": "low"},
}


def load_messages() -> list[dict]:
    return json.loads((FOLDER / "messages.json").read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--settings", nargs="+", choices=list(SETTINGS), default=list(SETTINGS))
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--max-budget", type=float, default=0.5)
    args = parser.parse_args()

    client, messages, lines, spent = anthropic.Anthropic(), load_messages(), [], 0.0
    for name in args.settings:
        for m in messages:
            for pass_ in range(1, args.repetitions + 1):
                if spent >= args.max_budget:
                    raise SystemExit(f"Budget of ${args.max_budget} reached: stopping.")
                start = time.perf_counter()
                try:
                    decision = by_code(m["message"]) or classify(client, m["message"], **SETTINGS[name])
                except RoutingImpossible as error:  # counted as a classification error
                    decision = Decision("error", str(error), SETTINGS[name]["model"])
                duration = time.perf_counter() - start
                spent += decision.cost
                lines.append({"setting": name, "id": m["id"], "pass": pass_, "expected": m["expected"],
                              "obtained": decision.category, "reason": decision.reason, "by": decision.by,
                              "cost_dollars": round(decision.cost, 6), "duration_s": round(duration, 2)})

    output = FOLDER / "results" / "routing.csv"
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(lines[0]))
        writer.writeheader()
        writer.writerows(lines)

    print(f"{'setting':22} {'success':>9} {'vote of 3':>9} {'missed compl.':>15} {'cost/message':>13} {'median dur.':>11}")
    for name in args.settings:
        g = [l for l in lines if l["setting"] == name]
        correct = sum(l["obtained"] == l["expected"] for l in g)
        votes = {}
        for m in messages:
            passes = [Decision(l["obtained"], "", l["by"]) for l in g if l["id"] == m["id"] and l["obtained"] != "error"]
            votes[m["id"]] = vote(passes) if passes else "error"
        vote_correct = sum(votes[m["id"]] == m["expected"] for m in messages)
        missed = sum(l["expected"] == "complaint" and l["obtained"] != "complaint" for l in g)
        calls = [l for l in g if l["by"] != "code"]
        print(f"{name:22} {correct:>4}/{len(g):<4} {vote_correct:>4}/{len(messages):<4} {missed:>15} "
              f"{statistics.mean(l['cost_dollars'] for l in calls):>13.6f} {statistics.median(l['duration_s'] for l in calls):>10.1f}s")
        errors = Counter((l["id"], l["expected"], l["obtained"]) for l in g if l["obtained"] != l["expected"])
        for (id_, expected, obtained), n in sorted(errors.items()):
            print(f"{'':22}   {id_}: {expected} → {obtained} ({n} times out of {args.repetitions})")
    print(f"\nSpent: ${spent:.4f}; details: {output}")


if __name__ == "__main__":
    main()
