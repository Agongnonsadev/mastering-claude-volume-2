"""Chapter 8: the Comptoir's dashboard, drawn from the log. No call to the API.

Run, from the python/ folder:
    python -m ch08.dashboard
    python -m ch08.dashboard --html log/dashboard.html
"""

import argparse
from pathlib import Path

from comptoir import config
from comptoir.dashboard import by_day, failure_modes, latencies, load, to_html, to_pick_up


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--log", default=config.LOG)
    parser.add_argument("--html", help="also write an HTML page at this path")
    args = parser.parse_args()

    lines = load(args.log)
    print("Day         Calls   Cost ($)   Failures")
    for day, d in by_day(lines).items():
        print(f"{day}  {d['calls']:5}  {d['dollars']:9.4f}  {d['failures']:9}")
    median, p95 = latencies(lines)
    if median is not None:
        print(f"\nLatency of successful calls: median {median:.0f} ms, 95th percentile {p95:.0f} ms")
    failures = failure_modes(lines)
    if failures:
        print("\nFailure modes (origin, code):")
        for (origin, code), number in failures.most_common():
            print(f"  {origin:12} {code:22} {number}")
    pick_up = to_pick_up(lines)
    if pick_up:
        print("\nConversations for Awa to pick up:")
        for r in pick_up:
            print(f"  {r['date']}  {r['conversation']}  ({r['reason']})")
    if args.html:
        Path(args.html).write_text(to_html(lines), encoding="utf-8")
        print(f"\nPage written: {args.html}")


if __name__ == "__main__":
    main()
