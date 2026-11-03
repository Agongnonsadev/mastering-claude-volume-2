"""Chapter 5: compare version 0 of the prompt (chapter 2) and version 1, on 20 cases.

Only one thing changes between the two variants: the system prompt (and the tag around
the customer's message, which goes with it). The model, the effort and max_tokens are the same.

Run, from the python/ folder:
    python -m ch05.evaluate_prompt --estimate
    python -m ch05.evaluate_prompt --repetitions 3 --max-budget 1
    python -m ch05.evaluate_prompt --regrade      (free: the current grid, on the answers already obtained)
"""

import argparse
import json
from pathlib import Path

import anthropic

from ch02.comptoir_cli import SYSTEM_PROMPT as PROMPT_V0
from comptoir import config
from comptoir.assistant import MAX_TOKENS, build_request
from comptoir.costs import RATES
from comptoir.evaluation import evaluate, read_csv, regrade, regressions, summarize, write_csv
from comptoir.notation import Case
from comptoir.prompt import load

FOLDER = Path(__file__).parent


def request_v0(case: Case) -> dict:
    request = {
        "model": config.MODEL,
        "max_tokens": MAX_TOKENS,
        "system": PROMPT_V0,
        "messages": [{"role": "user", "content": case.question}],
    }
    if config.EFFORT:
        request["output_config"] = {"effort": config.EFFORT}
    return request


def request_v1(case: Case) -> dict:
    return build_request(case.question, prompt=load("v1"))


VARIANTS = {"v0": request_v0, "v1": request_v1}


def load_cases() -> list[Case]:
    return [Case.from_dict(d) for d in json.loads((FOLDER / "cases.json").read_text(encoding="utf-8"))]


def estimate(client, cases, repetitions: int, assumed_output: int) -> float:
    rate = RATES[config.MODEL]
    total = 0.0
    for build in VARIANTS.values():
        for c in cases:
            request = build(c)
            counting = {k: request[k] for k in ("model", "system", "messages")}
            input_tokens = client.messages.count_tokens(**counting).input_tokens
            total += repetitions * (input_tokens * rate.input + assumed_output * rate.output) / 1_000_000
    return total


def show(trials) -> None:
    for line in summarize(trials):
        per_success = f"${line['cost_per_success']:.5f}" if line["cost_per_success"] else "—"
        print(f"{line['variant']}: success {line['success']:.0%} · {per_success} per success · "
              f"median latency {line['median_latency_s']:.1f} s")
    lost = regressions(trials, "v0", "v1")
    print("Regressions of v1 compared with v0:", ", ".join(lost) if lost else "none")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--max-budget", type=float, default=1.0)
    parser.add_argument("--estimate", action="store_true")
    parser.add_argument("--assumed-output", type=int, default=250)
    parser.add_argument("--regrade", action="store_true")
    args = parser.parse_args()

    if args.regrade:
        trials = regrade(read_csv(FOLDER / "results" / "trials.csv"), load_cases())
        write_csv(trials, FOLDER / "results" / "trials-regraded.csv")
        show(trials)
        return

    client = anthropic.Anthropic()
    cases = load_cases()
    print(f"Model: {config.MODEL} · effort: {config.EFFORT or 'default'} · prompt v1: {load('v1').id}")
    if args.estimate:
        total = estimate(client, cases, args.repetitions, args.assumed_output)
        print(f"Estimated cost: ${total:.2f} ({len(cases)} cases × 2 versions × {args.repetitions} repetitions)")
        return

    trials = evaluate(client, cases, VARIANTS, args.repetitions, args.max_budget)
    write_csv(trials, FOLDER / "results" / "trials.csv")
    show(trials)


if __name__ == "__main__":
    main()
