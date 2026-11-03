"""Chapter 13: one session of the restocking agent, with its trace, its order and its criteria.

Run, from the python/ folder:  python -m ch13.restock
Variants:  --no-subagent   --model claude-haiku-5-5   --memory workshop_memory
           --task-budget 40000   --clear-after 8000   --compact-after-turn 2
           --max-turns 3   --max-budget 0.05
"""

import argparse
from pathlib import Path

import anthropic

from ch13.criteria import criteria
from comptoir import config
from comptoir.restock_agent import Guard, Settings, run
from comptoir.workshop import Workshop, render_order


def arguments(parser: argparse.ArgumentParser) -> argparse.ArgumentParser:
    parser.add_argument("--model", default=config.MODEL)
    parser.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"])
    parser.add_argument("--no-subagent", action="store_true", help="the agent reads all the messages itself")
    parser.add_argument("--memory", type=Path, help="folder of the agent's memory, kept from one week to the next")
    parser.add_argument("--task-budget", type=int, help="in tokens, 20,000 at least (beta)")
    parser.add_argument("--clear-after", type=int, help="clears the old tool results beyond N tokens")
    parser.add_argument("--compact-after-turn", type=int, help="summarizes the session after this turn (beta)")
    parser.add_argument("--max-turns", type=int, default=20)
    parser.add_argument("--max-budget", type=float, default=0.50, help="in dollars, for the session")
    parser.add_argument("--timeout", type=float, default=300, help="in seconds, for the session")
    return parser


def settings_and_guard(args) -> tuple[Settings, Guard]:
    return (Settings(model=args.model, effort=args.effort, subagent=not args.no_subagent,
                     memory=args.memory, task_budget=args.task_budget,
                     clear_results_after=args.clear_after, compact_after_turn=args.compact_after_turn),
            Guard(max_turns=args.max_turns, budget_dollars=args.max_budget, timeout_s=args.timeout))


def main() -> None:
    parser = arguments(argparse.ArgumentParser(description=__doc__.splitlines()[0]))
    parser.add_argument("--orders", type=Path, help="file where the proposed orders are kept (default: in memory)")
    args = parser.parse_args()
    settings, guard = settings_and_guard(args)
    if args.memory:
        args.memory.mkdir(parents=True, exist_ok=True)
    result = run(anthropic.Anthropic(), Workshop(orders=args.orders), settings, guard)
    print(result.trace.show())
    print(f"\nStop: {result.stop or 'finished by the agent'}; {result.turns} turns; ${result.spent:.4f} "
          f"(subagent ${result.subagent_cost:.4f}); {result.duration_s:.1f} s; "
          f"largest context: {result.context_peak} tokens")
    if result.clearings:
        print(f"Clearings: {result.clearings}")
    print("\n" + (render_order(result.order) if result.order else "No order proposed."))
    print("\nThe agent's summary:\n" + result.text)
    print("\nCriteria: " + ", ".join(f"{k} {'yes' if v else 'NO'}"
                                     for k, v in criteria(result.order, memory=args.memory is not None).items()))


if __name__ == "__main__":
    main()
