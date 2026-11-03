"""Chapter 13: several sessions of the agent per setting, its criteria, its cost and its duration.

Run, from the python/ folder:  python -m ch13.evaluate_agent --repetitions 3 --max-budget 2
Settings:  sonnet (subagent for the messages), sonnet-direct-reading, haiku, opus
Each session is kept in ch13/results/sessions.jsonl, for the review.
"""

import argparse
import csv
import json
import statistics
from dataclasses import asdict
from pathlib import Path

import anthropic

from ch13.criteria import criteria
from comptoir.restock_agent import Guard, Settings, run
from comptoir.workshop import Workshop

FOLDER = Path(__file__).parent / "results"
SETTINGS = {
    "sonnet": Settings(),
    "sonnet-direct-reading": Settings(subagent=False),
    "haiku": Settings(model="claude-haiku-5-5"),
    "opus": Settings(model="claude-opus-5-5"),
}


def summary_lines(text: str) -> int:
    return sum(1 for line in text.splitlines() if line.strip())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--settings", nargs="+", choices=list(SETTINGS), default=["sonnet", "sonnet-direct-reading",
                                                                                 "haiku"])
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--max-budget", type=float, default=2.0, help="in dollars, for the whole evaluation")
    parser.add_argument("--output", default="agent.csv")
    args = parser.parse_args()

    client, rows, spent = anthropic.Anthropic(), [], 0.0
    FOLDER.mkdir(exist_ok=True)
    with (FOLDER / "sessions.jsonl").open("a", encoding="utf-8") as sessions:
        for name in args.settings:
            for run_number in range(1, args.repetitions + 1):
                if spent >= args.max_budget:
                    raise SystemExit(f"Budget of ${args.max_budget} reached: stopping.")
                r = run(client, Workshop(), SETTINGS[name], Guard(budget_dollars=0.60))
                spent += r.spent
                verdict = criteria(r.order)
                row = {"setting": name, "run": run_number, "stop": r.stop or "", "turns": r.turns,
                       "cost_dollars": round(r.spent, 5), "of_which_subagent": round(r.subagent_cost, 5),
                       "duration_s": round(r.duration_s, 1), "context_peak": r.context_peak, "tool_calls": len(r.tools),
                       "total_fcfa": r.order.total_fcfa if r.order else "", "summary_lines": summary_lines(r.text),
                       "criteria_met": sum(verdict.values()), **verdict}
                rows.append(row)
                sessions.write(json.dumps({**row, "order": asdict(r.order) if r.order else None, "summary": r.text,
                                           "tools": r.tools, "trace": r.trace.show()}, ensure_ascii=False) + "\n")
                print(f"{name:24} {run_number}  {row['criteria_met']}/{len(verdict)}  {r.turns:>2} turns  "
                      f"${r.spent:.4f}  {r.duration_s:5.1f} s  {r.stop or ''}")

    with (FOLDER / args.output).open("w", newline="", encoding="utf-8") as f:
        columns = list(dict.fromkeys(k for row in rows for k in row))
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)
    print(f"\n{'setting':24} {'sessions':>8} {'criteria':>9} {'avg cost':>10} {'med. time':>9} {'turns':>6} {'max context':>11}")
    for name in args.settings:
        g = [row for row in rows if row["setting"] == name]
        print(f"{name:24} {len(g):>8} {sum(row['criteria_met'] for row in g):>4}/{7 * len(g):<4} "
              f"${statistics.mean(row['cost_dollars'] for row in g):>9.4f} {statistics.median(row['duration_s'] for row in g):>8.1f}s "
              f"{statistics.mean(row['turns'] for row in g):>6.1f} {max(row['context_peak'] for row in g):>11}")
    print(f"\nSpent: ${spent:.4f}")


if __name__ == "__main__":
    main()
