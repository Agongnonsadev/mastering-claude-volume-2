"""Evaluate variants (prompts, models, settings) on the same set of cases (chapter 5).

A variant is a function that, for a case, returns the request to send. Each case is
asked several times, graded, and compared: success, cost per success, regressions.
Chapter 17 turns this into a real evaluation suite.
"""

import csv
import statistics
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, replace
from pathlib import Path

from comptoir.costs import cost
from comptoir.log import log_call
from comptoir.notation import Case, Grade, grade

Variant = Callable[[Case], dict]


@dataclass
class Trial:
    variant: str
    case: str
    repetition: int
    passed: bool
    reasons: str
    to_review: str
    answer: str
    latency_s: float
    input_tokens: int
    output_tokens: int
    cost_dollars: float
    stop_reason: str


def grade_trial(case: Case, text: str, stop_reason: str) -> Grade:
    """The case's criteria, plus a common rule: an answer that does not stop on end_turn fails."""
    result = grade(case, text)
    if stop_reason != "end_turn":
        result.passed = False
        result.reasons.append(f"stop: {stop_reason}")
    return result


def run_trial(client, name: str, request: dict, case: Case, repetition: int) -> Trial:
    start = time.perf_counter()
    message = client.messages.create(**request)
    latency = time.perf_counter() - start
    text = "".join(b.text for b in message.content if b.type == "text")
    price = cost(request["model"], message.usage)
    log_call(message._request_id, request["model"], price, prompt=name)
    result = grade_trial(case, text, message.stop_reason)
    return Trial(name, case.id, repetition, result.passed, "; ".join(result.reasons), result.to_review,
                 text, round(latency, 2), price.input, price.output, price.dollars, message.stop_reason)


def evaluate(client, cases: list[Case], variants: dict[str, Variant], repetitions: int, max_budget: float) -> list[Trial]:
    trials, spent = [], 0.0
    for name, build in variants.items():
        for c in cases:
            for r in range(1, repetitions + 1):
                if spent >= max_budget:
                    print(f"Budget of ${max_budget} reached: stopping.")
                    return trials
                trial = run_trial(client, name, build(c), c, r)
                spent += trial.cost_dollars
                trials.append(trial)
    return trials


def summarize(trials: list[Trial]) -> list[dict]:
    lines = []
    for name in dict.fromkeys(t.variant for t in trials):
        group = [t for t in trials if t.variant == name]
        successes = sum(t.passed for t in group)
        total = sum(t.cost_dollars for t in group)
        lines.append({
            "variant": name,
            "trials": len(group),
            "success": successes / len(group),
            "cost_per_call": total / len(group),
            "cost_per_success": total / successes if successes else None,
            "median_latency_s": statistics.median(t.latency_s for t in group),
        })
    return lines


def rate_per_case(trials: list[Trial], variant: str) -> dict[str, float]:
    per_case: dict[str, list[bool]] = {}
    for t in trials:
        if t.variant == variant:
            per_case.setdefault(t.case, []).append(t.passed)
    return {c: sum(v) / len(v) for c, v in per_case.items()}


def regressions(trials: list[Trial], before: str, after: str) -> list[str]:
    """The cases better passed by the old variant than by the new one."""
    a, b = rate_per_case(trials, before), rate_per_case(trials, after)
    return sorted(c for c in a if c in b and b[c] < a[c])


def regrade(trials: list[Trial], cases: list[Case]) -> list[Trial]:
    """Applies the current grid to answers already obtained: no call, no cost.

    To be kept for a correction of the grid decided for a written reason, and applied
    to all variants at once; both results, before and after, are kept.
    """
    by_id = {c.id: c for c in cases}
    regraded = []
    for t in trials:
        result = grade_trial(by_id[t.case], t.answer, t.stop_reason)
        regraded.append(replace(t, passed=result.passed, reasons="; ".join(result.reasons), to_review=result.to_review))
    return regraded


def read_csv(path: Path) -> list[Trial]:
    types = {"repetition": int, "input_tokens": int, "output_tokens": int,
             "latency_s": float, "cost_dollars": float, "passed": lambda v: v == "True"}
    with path.open(newline="", encoding="utf-8") as f:
        return [Trial(**{k: types.get(k, str)(v) for k, v in line.items()}) for line in csv.DictReader(f)]


def write_csv(trials: list[Trial], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(Trial.__dataclass_fields__))
        writer.writeheader()
        for t in trials:
            writer.writerow(asdict(t))
