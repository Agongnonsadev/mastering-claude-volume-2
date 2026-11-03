"""Chapter 17: compare two series of trials, case by case, and say whether the gap goes beyond chance.

Run, from the python/ folder (free: no call):
    python -m ch17.compare <series A> <series B> [--judge-model claude-haiku-5-5]

Three precautions:
- the two series must have received the same messages (the cases' fingerprint, in the register); they
  are graded here by the same grading, the grading of the day;
- the comparison is case by case: a case won, a case lost, and not an average;
- the sign test says whether a majority of cases moving in the same direction can come from chance.
  It proves nothing on one or two cases: more trials, or more cases, are then needed.
"""

import argparse
import json
from math import comb
from pathlib import Path

from ch17.judge import RUBRIC
from ch17.suite import REGISTER, load_cases, rate_per_case, read_judgments, read_series, show, summarize


def sign_test(won: int, lost: int) -> float:
    """Probability of a gap at least as clear if the two versions were equal (two-sided)."""
    n = won + lost
    if n == 0:
        return 1.0
    k = min(won, lost)
    return min(1.0, 2 * sum(comb(n, i) for i in range(k + 1)) / 2 ** n)


def entry(series: Path) -> dict | None:
    if not REGISTER.exists():
        return None
    with REGISTER.open(encoding="utf-8") as f:
        lines = [json.loads(l) for l in f if l.strip()]
    return next((l for l in reversed(lines) if l["series"] == series.name), None)


def compare(a: dict[str, float], b: dict[str, float]) -> tuple[list[str], list[str]]:
    """The cases B passes more often, and those A passes more often."""
    common = sorted(set(a) & set(b))
    return [c for c in common if b[c] > a[c]], [c for c in common if b[c] < a[c]]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("a")
    parser.add_argument("b")
    parser.add_argument("--judge-model")
    parser.add_argument("--rubric", default=RUBRIC)
    args = parser.parse_args()
    cases = load_cases()
    series = [Path(args.a), Path(args.b)]
    infos = [entry(s) for s in series]
    if all(infos):
        for key in ("cases_fingerprint", "set"):
            if infos[0][key] != infos[1][key]:
                raise SystemExit(f"Series not comparable: different {key} ({infos[0][key]} / {infos[1][key]}).")
    rates = []
    for s, info in zip(series, infos):
        trials = read_series(s)
        judgments = read_judgments(s, args.judge_model, args.rubric) if args.judge_model else None
        print(f"\n{s.name}" + (f" — {info['versions']}" if info else ""))
        print(show(summarize(trials, cases, judgments)))
        rates.append(rate_per_case(trials, cases, judgments))
    won, lost = compare(*rates)
    print(f"\nCases B passes more often: {len(won)} {won}")
    print(f"Cases A passes more often: {len(lost)} {lost}")
    print(f"Sign test: p = {sign_test(len(won), len(lost)):.2f} "
          "(below 0.05, the gap is unlikely to come from chance)")


if __name__ == "__main__":
    main()
