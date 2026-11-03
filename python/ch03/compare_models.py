"""Chapter 3: compare models and effort levels on the Comptoir's cases.

For each configuration (model, effort), each case is asked several times, because
answers vary. The success, the cost, the latency and the thinking are recorded, then
the cost per successful task is calculated.

Run, from the python/ folder:
    python -m ch03.compare_models --estimate        # free: cost estimate before running
    python -m ch03.compare_models --repetitions 3 --max-budget 2
"""

import argparse
import csv
import json
import statistics
import time
from dataclasses import dataclass
from pathlib import Path

import anthropic

from ch02.comptoir_cli import SYSTEM_PROMPT
from comptoir.costs import RATES, cost
from comptoir.log import log_call
from comptoir.notation import Case, grade

CONFIGURATIONS = [
    ("claude-opus-5-5", "medium"),
    ("claude-opus-5-5", "low"),
    ("claude-sonnet-5-5", "high"),
    ("claude-sonnet-5-5", "low"),
    ("claude-haiku-5-5", "medium"),
    ("claude-haiku-5-5", "low"),
]

FOLDER = Path(__file__).parent


def load_cases(path: Path = FOLDER / "cases.json") -> list[Case]:
    return [Case.from_dict(d) for d in json.loads(path.read_text(encoding="utf-8"))]


@dataclass
class Trial:
    model: str
    effort: str
    case: str
    repetition: int
    passed: bool
    reasons: str
    to_review: str
    answer: str
    latency_s: float
    input_tokens: int
    output_tokens: int
    thinking_tokens: int
    cost_dollars: float
    stop_reason: str


def ask(client, model: str, effort: str, case: Case, repetition: int) -> Trial:
    start = time.perf_counter()
    message = client.messages.create(
        model=model,
        max_tokens=2000,
        system=SYSTEM_PROMPT,
        output_config={"effort": effort},
        messages=[{"role": "user", "content": case.question}],
    )
    latency = time.perf_counter() - start
    text = "".join(b.text for b in message.content if b.type == "text")
    price = cost(model, message.usage)
    log_call(message._request_id, model, price)
    result = grade(case, text)
    if message.stop_reason != "end_turn":
        result.passed = False
        result.reasons.append(f"stop: {message.stop_reason}")
    return Trial(
        model, effort, case.id, repetition, result.passed, "; ".join(result.reasons),
        result.to_review, text, round(latency, 2), price.input, price.output, price.thinking,
        price.dollars, message.stop_reason,
    )


def summarize(trials: list[Trial]) -> list[dict]:
    """One line per configuration: success rate, costs, latency, thinking."""
    lines = []
    for model, effort in dict.fromkeys((t.model, t.effort) for t in trials):
        group = [t for t in trials if t.model == model and t.effort == effort]
        successes = sum(t.passed for t in group)
        total_cost = sum(t.cost_dollars for t in group)
        lines.append({
            "model": model,
            "effort": effort,
            "trials": len(group),
            "success": successes / len(group),
            "cost_per_call": total_cost / len(group),
            # The figure that counts: what a usable answer costs.
            "cost_per_success": total_cost / successes if successes else None,
            "median_latency_s": statistics.median(t.latency_s for t in group),
            "average_thinking": statistics.mean(t.thinking_tokens for t in group),
        })
    return lines


def compare(client, cases: list[Case], configurations, repetitions: int, max_budget: float) -> list[Trial]:
    trials, spent = [], 0.0
    for model, effort in configurations:
        for c in cases:
            for r in range(1, repetitions + 1):
                if spent >= max_budget:
                    print(f"Budget of ${max_budget} reached: stopping the comparison.")
                    return trials
                trial = ask(client, model, effort, c, r)
                spent += trial.cost_dollars
                trials.append(trial)
    return trials


def estimate(client, cases: list[Case], configurations, repetitions: int, assumed_output: int) -> float:
    """Free estimate: input tokens counted, output tokens assumed."""
    total = 0.0
    for model, _ in configurations:
        rate = RATES[model]
        for c in cases:
            input_tokens = client.messages.count_tokens(
                model=model, system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": c.question}],
            ).input_tokens
            total += repetitions * (input_tokens * rate.input + assumed_output * rate.output) / 1_000_000
    return total


def write_csv(trials: list[Trial], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(Trial.__dataclass_fields__))
        writer.writeheader()
        for t in trials:
            writer.writerow(t.__dict__)


def show(lines: list[dict]) -> None:
    print(f"{'Model':<20}{'Effort':<8}{'Success':>10}{'$/call':>11}{'$/success':>12}{'Latency':>9}{'Thinking':>11}")
    for l in lines:
        per_success = f"{l['cost_per_success']:.5f}" if l["cost_per_success"] else "—"
        print(
            f"{l['model']:<20}{l['effort']:<8}{l['success']:>9.0%} {l['cost_per_call']:>10.5f}"
            f"{per_success:>12}{l['median_latency_s']:>8.1f}s{l['average_thinking']:>11.0f}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--max-budget", type=float, default=2.0, help="stop beyond this amount, in dollars")
    parser.add_argument("--estimate", action="store_true", help="estimate the cost without calling the model")
    parser.add_argument("--assumed-output", type=int, default=300, help="output tokens assumed per call")
    args = parser.parse_args()

    client = anthropic.Anthropic()
    cases = load_cases()
    if args.estimate:
        total = estimate(client, cases, CONFIGURATIONS, args.repetitions, args.assumed_output)
        print(f"{len(cases)} cases × {len(CONFIGURATIONS)} configurations × {args.repetitions} repetitions")
        print(f"Estimated cost: ${total:.2f} (with {args.assumed_output} output tokens assumed per call)")
        return

    trials = compare(client, cases, CONFIGURATIONS, args.repetitions, args.max_budget)
    write_csv(trials, FOLDER / "results" / "trials.csv")
    show(summarize(trials))
    to_review = sorted({(t.case, t.to_review) for t in trials if t.to_review})
    if to_review:
        print("\nTo review by hand (see results/trials.csv):")
        for case_id, instruction in to_review:
            print(f"- {case_id}: {instruction}")


if __name__ == "__main__":
    main()
