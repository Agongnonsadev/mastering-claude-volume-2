"""Chapter 13: Awa approves or rejects an order proposed by the agent, and can leave it feedback.

Run, from the python/ folder:
    python -m ch13.approve_order --orders orders.json --list
    python -m ch13.approve_order --orders orders.json BC-1a2b3c --approve
    python -m ch13.approve_order --orders orders.json BC-1a2b3c --reject --note "..." --memory workshop_memory

The decision goes through no model: it is the only path that takes an order out of
“to be approved”. The note, if a memory folder is given, is added to the file that the agent
will read next Monday. It is the code that writes it, not the agent.
"""

import argparse
from datetime import date
from pathlib import Path

from comptoir.workshop import Workshop, render_order

FEEDBACK_FILE = "awa-feedback.md"


def leave_feedback(memory: Path, code: str, decision: str, note: str, day: date) -> Path:
    # The SDK's memory tool serves the “memories” subfolder of the folder given: that is where to write.
    root = memory / "memories"
    root.mkdir(parents=True, exist_ok=True)
    path = root / FEEDBACK_FILE
    if not path.exists():
        path.write_text("# Awa's feedback on purchase orders\n\n", encoding="utf-8")
    with path.open("a", encoding="utf-8") as f:
        f.write(f"- {day.isoformat()}, order {code} {decision}: {note}\n")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--orders", type=Path, required=True)
    parser.add_argument("code", nargs="?")
    decision = parser.add_mutually_exclusive_group()
    decision.add_argument("--approve", action="store_true")
    decision.add_argument("--reject", action="store_true")
    decision.add_argument("--list", action="store_true")
    parser.add_argument("--note")
    parser.add_argument("--memory", type=Path, help="the agent's memory folder")
    args = parser.parse_args()

    workshop = Workshop(orders=args.orders)
    if args.list or not args.code:
        for order in workshop.orders():
            print(render_order(order) + "\n")
        return
    if not (args.approve or args.reject):
        parser.error("--approve or --reject")
    order = workshop.decide(args.code, approved=args.approve, note=args.note)
    print(render_order(order))
    if args.note and args.memory:
        path = leave_feedback(args.memory, order.code, order.status, args.note, workshop.today)
        print(f"Feedback left in {path}")


if __name__ == "__main__":
    main()
