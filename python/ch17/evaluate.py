"""Chapter 17: the Comptoir's evaluation suite, on the command line.

From the python/ folder:
    python -m ch17.evaluate estimate --set improvement --trials 3                  (free)
    python -m ch17.evaluate run --variant reference --set improvement --trials 3 --max-budget 1   (PAID)
    python -m ch17.evaluate judge <series> --model claude-haiku-5-5 --max-budget 0.3                (PAID)
    python -m ch17.evaluate summarize <series> [--judge-model claude-haiku-5-5]                     (free)
    python -m ch17.evaluate regrade <series> --reason "…"                                          (free)
    python -m ch17.evaluate graduate <series>                                                      (free)
    python -m ch17.evaluate regression --max-budget 0.3                       (PAID: the shipped version)

The “verification” set is used only at the end, for the chosen version: the script asks for
--i-am-shipping to run it, so that it is not used, without meaning to, for working.
"""

import argparse
import csv
import json
import statistics
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from ch17 import judge as judge_
from ch17.code_grading import grade
from ch17.judge import RUBRIC
from ch17.suite import (REGISTER, SERIES, VARIANTS, cases_fingerprint, grading_fingerprint, judgments_path,
                        load_cases, read_judgments, read_series, record_in_register, register_entry, run, show,
                        summarize, write_series)
from comptoir.call import make_client
from comptoir.costs import RATES
from comptoir.knowledge import load_knowledge

FOLDER = Path(__file__).parent
REGRESSION = FOLDER / "regression.json"
JUDGE_ASSUMED_OUTPUT = 600  # output tokens assumed per judgment, thinking included, for the estimate


def costs_of_chapter_12() -> dict[str, float]:
    """The average cost of a message per category, measured in chapter 12 with the router."""
    with (FOLDER.parent / "ch12" / "results" / "comptoir.csv").open(encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if r["mode"] == "routed"]
    return {c: statistics.mean(float(r["cost_dollars"]) for r in rows if r["expected"] == c)
            for c in {r["expected"] for r in rows}}


def cmd_estimate(args) -> None:
    cases = load_cases(args.set)
    averages = costs_of_chapter_12()
    total = sum(averages[c["category"][0]] for c in cases) * args.trials
    print(f"{len(cases)} cases × {args.trials} trials with the shipped version: about ${total:.2f} "
          f"(average costs measured in chapter 12: "
          + ", ".join(f"{k} ${v:.4f}" for k, v in sorted(averages.items())) + ")")
    client = make_client()
    example = judge_.request(cases[0], _fake_trial(cases[0]), args.judge_model)
    input_tokens = client.messages.count_tokens(
        **{k: example[k] for k in ("model", "system", "messages", "output_config")}).input_tokens
    rate = RATES[args.judge_model]
    per_judgment = (input_tokens * rate.input + JUDGE_ASSUMED_OUTPUT * rate.output) / 1_000_000
    print(f"Judge {args.judge_model}: {input_tokens} input tokens per judgment (free counting), at most "
          f"${per_judgment:.4f} without the cache, that is ${per_judgment * len(cases) * args.trials:.2f} for all the trials")


def _fake_trial(case: dict):
    from ch17.harness import Trial
    return Trial("estimate", case["id"], 1, text="Example answer.", claude_text="Example answer.")


def cmd_run(args) -> None:
    if args.set == "verification" and not args.i_am_shipping:
        raise SystemExit("The verification set is run once, for the chosen version: add --i-am-shipping.")
    variant = VARIANTS[args.variant]
    cases = load_cases(args.set, args.cases)
    folder = SERIES / f"{datetime.now():%Y%m%d-%H%M%S}-{variant.name}-{args.set}"
    print(f"Variant {variant.name} · set {args.set} ({len(cases)} cases, fingerprint {cases_fingerprint(cases)}) · "
          f"{args.trials} trials · ceiling ${args.max_budget}")
    trials, stopped = run(make_client(), variant, cases, args.trials, args.max_budget, load_knowledge(),
                          parallel=args.parallel)
    write_series(folder, trials)
    summary = summarize(trials, cases)
    record_in_register(register_entry(folder, variant, args.set, cases, args.trials, summary, stopped))
    print(("\nBUDGET REACHED: incomplete series.\n" if stopped else "\n") + show(summary))
    print(f"Series: {folder}")


def cmd_judge(args) -> None:
    folder = Path(args.series)
    trials = read_series(folder)
    if args.sample:
        kept = set(json.loads(Path(args.sample).read_text(encoding="utf-8"))["trials"])
        trials = [t for t in trials if t.identifier in kept]
    already = read_judgments(folder, args.model, args.rubric)
    to_judge = [t for t in trials if t.identifier not in already]
    cases = {c["id"]: c for c in load_cases()}
    rubric = judge_.load_rubric(args.rubric)
    client, lock, spent = make_client(), threading.Lock(), [0.0]
    path = judgments_path(folder, args.model, args.rubric)
    print(f"{len(to_judge)} trials to judge by {args.model} ({rubric.id}), {len(already)} already judged")

    def one(trial):
        with lock:
            if spent[0] >= args.max_budget:
                return None
        j = judge_.judge(client, cases[trial.case], trial, args.model, rubric)
        with lock:
            spent[0] += j.cost_dollars
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps({**asdict(j), "outcome": j.outcome}, ensure_ascii=False) + "\n")
        print(f"  {trial.identifier:45} {j.outcome:9} ${j.cost_dollars:.5f} "
              + " ".join(f"{c}={v}" for c, v in j.verdicts.items()) + (f" {j.error}" if j.error else ""))
        return j

    if to_judge:
        one(to_judge[0])  # the first one alone: it writes the documents to the cache
        with ThreadPoolExecutor(max_workers=args.parallel) as executor:
            list(executor.map(one, to_judge[1:]))
    print(f"Judge's spending: ${spent[0]:.4f}")
    cmd_summarize(argparse.Namespace(series=str(folder), judge_model=args.model, rubric=args.rubric))


def cmd_summarize(args) -> None:
    folder = Path(args.series)
    trials = read_series(folder)
    cases = load_cases()
    judgments = read_judgments(folder, args.judge_model, args.rubric) if args.judge_model else None
    print(show(summarize(trials, cases, judgments)))


def cmd_regrade(args) -> None:
    """The current grading, applied to the answers already obtained: no call, no cost.
    A new line enters the register, with the new fingerprint of the grading; the old one stays."""
    folder = Path(args.series)
    with REGISTER.open(encoding="utf-8") as f:
        before = next(l for l in reversed([json.loads(x) for x in f if x.strip()]) if l["series"] == folder.name)
    trials = read_series(folder)
    cases = load_cases(ids=sorted({t.case for t in trials}))
    summary = summarize(trials, cases)
    entry = {**before, "summary": summary, "grading_fingerprint": grading_fingerprint(),
             "cases_fingerprint": cases_fingerprint(cases), "regrading": True,
             "date": datetime.now(timezone.utc).isoformat(timespec="seconds"), "reason": args.reason}
    record_in_register(entry)
    print(f"Grading {before['grading_fingerprint']}: success (code) {before['summary']['code_success']:.0%}")
    print(f"Grading {entry['grading_fingerprint']}: success (code) {summary['code_success']:.0%}")
    print(show(summary))


def cmd_graduate(args) -> None:
    """The cases the code passes at every trial of a series enter the regression:
    from “can we do it?”, they move to “do we still do it?”."""
    folder = Path(args.series)
    trials = read_series(folder)
    cases = {c["id"]: c for c in load_cases()}
    by_case: dict[str, list[bool]] = {}
    for t in trials:
        by_case.setdefault(t.case, []).append(not grade(cases[t.case], t))
    kept = sorted(c for c, v in by_case.items() if all(v))
    REGRESSION.write_text(json.dumps({"series": folder.name, "grading_fingerprint": grading_fingerprint(), "cases": kept},
                                     ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(kept)} cases out of {len(by_case)} enter the regression → {REGRESSION}")


def cmd_regression(args) -> int:
    """The cases the shipped version passes at every trial: one trial each, graded by the code.
    Exit code 1 at the first failure: enough to block a change, by hand or in CI (chapter 20)."""
    ids = json.loads(REGRESSION.read_text(encoding="utf-8"))["cases"]
    cases = load_cases(ids=ids)
    variant = VARIANTS[args.variant]
    trials, stopped = run(make_client(), variant, cases, 1, args.max_budget, load_knowledge(), parallel=args.parallel)
    by_id = {c["id"]: c for c in cases}
    failures = {t.case: grade(by_id[t.case], t) for t in trials}
    failed = sorted(c for c, f in failures.items() if f)
    folder = SERIES / f"{datetime.now():%Y%m%d-%H%M%S}-{variant.name}-regression"
    write_series(folder, trials)
    summary = summarize(trials, cases)
    record_in_register(register_entry(folder, variant, "regression", cases, 1, summary, stopped))
    print(show(summary))
    if stopped or failed:
        print(f"REGRESSION: {'incomplete series; ' if stopped else ''}{len(failed)} cases failed: {', '.join(failed)}")
        return 1
    print(f"Regression: {len(cases)} cases out of {len(cases)}.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("estimate")
    p.add_argument("--set", default="improvement")
    p.add_argument("--trials", type=int, default=3)
    p.add_argument("--judge-model", default="claude-haiku-5-5")
    p = commands.add_parser("run")
    p.add_argument("--variant", default="reference", choices=sorted(VARIANTS))
    p.add_argument("--set", default="improvement", choices=["improvement", "verification"])
    p.add_argument("--cases", nargs="*", help="only these cases")
    p.add_argument("--trials", type=int, default=3)
    p.add_argument("--max-budget", type=float, default=1.0)
    p.add_argument("--parallel", type=int, default=4)
    p.add_argument("--i-am-shipping", action="store_true")
    p = commands.add_parser("judge")
    p.add_argument("series")
    p.add_argument("--model", default="claude-haiku-5-5")
    p.add_argument("--rubric", default=RUBRIC)
    p.add_argument("--sample")
    p.add_argument("--max-budget", type=float, default=0.3)
    p.add_argument("--parallel", type=int, default=4)
    p = commands.add_parser("summarize")
    p.add_argument("series")
    p.add_argument("--judge-model")
    p.add_argument("--rubric", default=RUBRIC)
    p = commands.add_parser("regrade")
    p.add_argument("series")
    p.add_argument("--reason", required=True, help="why the grading changed, written to the register")
    p = commands.add_parser("graduate")
    p.add_argument("series")
    p = commands.add_parser("regression")
    p.add_argument("--variant", default="shipped", choices=sorted(VARIANTS))
    p.add_argument("--max-budget", type=float, default=0.3)
    p.add_argument("--parallel", type=int, default=4)
    args = parser.parse_args()
    if args.command == "regression":
        return cmd_regression(args)
    {"estimate": cmd_estimate, "run": cmd_run, "judge": cmd_judge, "summarize": cmd_summarize,
     "regrade": cmd_regrade, "graduate": cmd_graduate}[args.command](args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
