"""Chapter 19: the judge of chapter 17, through the Batch API. Half the price, and the same grade?

From the python/ folder:
    python -m ch19.judge_in_batch <series> --estimate                     (free)
    python -m ch19.judge_in_batch <series> --max-wait 3600                (PAID, a batch)
    python -m ch19.judge_in_batch <series> --reread <batch>               (free: reread a finished batch)
    python -m ch19.judge_in_batch <series> --compare                      (free: the batch's file, without a call)

The judgments of a chapter 17 series are not in a hurry: they are done at night, or while Yao
does something else. Each judgment becomes a request of the batch, identical to that of the live judge
(ch17/judge.py), cached documents included: the documentation warns that the cache, in a batch, only
serves “on a best-effort basis”, the requests going through in any order. The script writes the judgments
next to those of the live judge (judgments-<model>-<rubric>-batch.jsonl) and compares: the cost, the duration,
and the agreement between the two judges, since the same judge never gives exactly the same grade twice.
"""

import argparse
import json
import re
import sys
import time
from dataclasses import asdict, fields
from pathlib import Path

from ch17 import judge as judge_
from ch17.suite import load_cases, read_judgments, read_series
from comptoir.costs import cost
from comptoir.log import log_call

ASSUMED_PRICE = 0.0002  # $ per judgment in batch, generous ($0.0004 live in chapter 17)


def batch_id(trial_id: str) -> str:
    """custom_id: letters, digits, hyphens and underscores, 64 characters at most."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", trial_id)[:64]


def requests(folder: Path, model: str) -> tuple[list[dict], dict[str, str]]:
    cases = {c["id"]: c for c in load_cases()}
    rubric = judge_.load_rubric()
    batch_requests, mapping = [], {}
    for trial in read_series(folder):
        if trial.error:
            continue
        key = batch_id(trial.identifier)
        if key in mapping:  # two trials reduced to the same custom_id: their results would mix
            raise ValueError(f"duplicate custom_id: {key}")
        mapping[key] = trial.identifier
        batch_requests.append({"custom_id": key, "params": judge_.request(cases[trial.case], trial, model, rubric)})
    return batch_requests, mapping


def read_results(client, batch: str, mapping: dict[str, str], model: str) -> list[judge_.Judgment]:
    rubric = judge_.load_rubric()
    judgments = []
    for entry in client.messages.batches.results(batch):
        judgment = judge_.Judgment(mapping[entry.custom_id], model, rubric.id)
        if entry.result.type != "succeeded":
            judgment.error = f"batch: {entry.result.type}"
            judgments.append(judgment)
            continue
        message = entry.result.message
        price = cost(model, message.usage, batch=True)
        log_call(message.id, model, price, prompt=rubric.id, stop_reason=message.stop_reason, batch=batch)
        judgment.cost_dollars = round(price.dollars, 6)
        if message.stop_reason != "end_turn":
            judgment.error = f"judgment stopped by {message.stop_reason}"
        else:
            data = json.loads("".join(b.text for b in message.content if b.type == "text"))
            judgment.verdicts = {c: data[c]["verdict"] for c in judge_.CRITERIA}
            judgment.findings = {c: data[c]["finding"] for c in judge_.CRITERIA}
        judgments.append(judgment)
    return judgments


def judgment(data: dict) -> judge_.Judgment:
    """A judgment read back from a file, without the computed fields written into it (“outcome”)."""
    return judge_.Judgment(**{f.name: data[f.name] for f in fields(judge_.Judgment) if f.name in data})


def compare(in_batch: list[judge_.Judgment], live: dict[str, dict]) -> dict:
    common = [j for j in in_batch if j.trial in live and not j.error]
    same_outcome = sum(1 for j in common if j.outcome == judgment(live[j.trial]).outcome)
    criteria = sum(1 for j in common for c in judge_.CRITERIA if j.verdicts.get(c) == live[j.trial]["verdicts"].get(c))
    return {
        "compared_judgments": len(common),
        "same_outcome": same_outcome,
        "same_verdicts": f"{criteria} out of {len(common) * len(judge_.CRITERIA)}",
        "batch_cost": round(sum(j.cost_dollars for j in in_batch), 4),
        "live_cost": round(sum(live[j.trial]["cost_dollars"] for j in common), 4),
        "batch_errors": [j.error for j in in_batch if j.error],
    }


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("series")
    parser.add_argument("--model", default="claude-haiku-5-5")
    parser.add_argument("--estimate", action="store_true")
    parser.add_argument("--max-wait", type=float, default=3600)
    parser.add_argument("--reread", help="a batch already launched")
    parser.add_argument("--compare", action="store_true",
                        help="compare the batch's file already read, without a call (free; the log already has its cost)")
    args = parser.parse_args()
    folder = Path(args.series)
    batch_requests, mapping = requests(folder, args.model)
    print(f"{len(batch_requests)} judgments; generous estimate: ${len(batch_requests) * ASSUMED_PRICE:.3f}")
    if args.estimate:
        return 0
    output = folder / f"judgments-{args.model}-{judge_.RUBRIC}-batch.jsonl"
    if args.compare:
        judgments = [judgment(json.loads(l)) for l in output.read_text(encoding="utf-8").splitlines() if l.strip()]
        return write_report(folder, args.model, {"batch": None, "duration_s": None}, judgments)

    from comptoir.call import make_client
    client = make_client()
    start = time.perf_counter()
    batch = args.reread
    if not batch:
        batch = client.messages.batches.create(requests=batch_requests).id
        print(f"Batch {batch} created.")
        while (state := client.messages.batches.retrieve(batch)).processing_status != "ended":
            if time.perf_counter() - start > args.max_wait:
                print(f"Not finished after {args.max_wait:.0f} s; run again with --reread {batch}")
                return 1
            print(f"  {time.perf_counter() - start:5.0f} s: {state.request_counts}")
            time.sleep(30)
    duration = round(time.perf_counter() - start, 1)
    judgments = read_results(client, batch, mapping, args.model)
    output.write_text("".join(json.dumps(asdict(j), ensure_ascii=False) + "\n" for j in judgments), encoding="utf-8")
    return write_report(folder, args.model, {"batch": batch, "duration_s": None if args.reread else duration}, judgments)


def write_report(folder: Path, model: str, header: dict, judgments: list[judge_.Judgment]) -> int:
    report = {**header, **compare(judgments, read_judgments(folder, model, judge_.RUBRIC))}
    print(json.dumps(report, ensure_ascii=False, indent=1))
    (folder / f"batch-{model}-{judge_.RUBRIC}.json").write_text(json.dumps(report, ensure_ascii=False, indent=1),
                                                               encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
