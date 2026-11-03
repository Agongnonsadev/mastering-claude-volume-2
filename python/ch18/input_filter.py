"""Chapter 18: an input filter with Claude Haiku 5.5, measured before being plugged in.

Anthropic's documentation suggests, against direct injection and jailbreaks, passing each message
through a small model that classifies it before the conversation (“harmlessness
screen”), with a structured output. This script measures it on messages whose answer is known:
the 12 attacks of chapter 17 and 4 of this chapter, against 51 honest messages, including
the 18 traps of chapter 17 (honest, but difficult). Two figures decide:
- the attacks spotted: what the filter brings;
- the honest messages wrongly flagged: what it would cost in customers badly served if it blocked.
A refusal of the model (stop_reason “refusal”) counts as a flag, as the page advises.

From the python/ folder:
    python -m ch18.input_filter --estimate                    (free)
    python -m ch18.input_filter --max-budget 0.1              (PAID, capped)
"""

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

FOLDER = Path(__file__).parent
ASSUMED_COST = 0.0005  # $ per message, generous
# The filter itself lives in comptoir/monitoring.py since chapter 19, which plugs it in as monitoring.
from comptoir.monitoring import INSTRUCTION, MODEL, SCHEMA, request  # noqa: E402,F401  (re-exported)


def labeled_messages() -> list[dict]:
    """(source, ID, message, attack): the truth, written before running the filter."""
    from ch17.suite import load_cases

    output = [{"source": "ch17", "id": c["id"], "message": c["message"], "attack": c["type"] == "security"}
              for c in load_cases()]
    attacks = {a["id"]: a for a in json.loads((FOLDER / "attacks.json").read_text(encoding="utf-8"))}
    m1, m2, m3 = attacks["three-message-escalation"]["messages"]
    output += [
        {"source": "ch18", "id": "escalation-1", "message": m1, "attack": False},  # on its own, this message is honest
        {"source": "ch18", "id": "escalation-2", "message": m2, "attack": True},
        {"source": "ch18", "id": "escalation-3", "message": m3, "attack": True},
        {"source": "ch18", "id": "fake-history", "message": attacks["fake-history"]["message"], "attack": True},
        {"source": "ch18", "id": "neighborhood-for-awa", "message": attacks["neighborhood-for-awa"]["message"],
         "attack": True},
        {"source": "ch18", "id": "pass-on-without-a-tool", "message": attacks["pass-on-without-a-tool"]["message"],
         "attack": False},
        {"source": "ch18", "id": "are-you-awa", "message": attacks["are-you-awa"]["message"], "attack": False},
    ]
    return output


def filter_message(client, message: str) -> dict:
    from comptoir.costs import cost

    start = time.perf_counter()
    response = client.messages.create(**request(message))
    duration = time.perf_counter() - start
    if response.stop_reason == "refusal":
        verdict = True  # no verdict to read: counted as a flag
    else:
        text = "".join(b.text for b in response.content if b.type == "text")
        verdict = json.loads(text)["manipulation"]
    return {"flagged": verdict, "stop": response.stop_reason, "duration_s": round(duration, 2),
            "cost_dollars": round(cost(MODEL, response.usage).dollars, 6)}


def summarize(results: list[dict]) -> dict:
    attacks = [r for r in results if r["attack"]]
    honest = [r for r in results if not r["attack"]]
    durations = sorted(r["duration_s"] for r in results)
    return {
        "attacks_spotted": f"{sum(r['flagged'] for r in attacks)} out of {len(attacks)}",
        "attacks_missed": [r["id"] for r in attacks if not r["flagged"]],
        "honest_wrongly_flagged": f"{sum(r['flagged'] for r in honest)} out of {len(honest)}",
        "false_flags": [r["id"] for r in honest if r["flagged"]],
        "median_duration_s": durations[len(durations) // 2] if durations else None,
        "total_cost_dollars": round(sum(r["cost_dollars"] for r in results), 4),
    }


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--estimate", action="store_true")
    parser.add_argument("--max-budget", type=float, default=0.1)
    args = parser.parse_args()
    messages = labeled_messages()
    print(f"{len(messages)} messages ({sum(m['attack'] for m in messages)} attacks); "
          f"generous estimate: ${len(messages) * ASSUMED_COST:.2f}")
    if args.estimate or len(messages) * ASSUMED_COST > args.max_budget:
        return 0 if args.estimate else 1

    from comptoir.call import make_client

    client = make_client()
    with ThreadPoolExecutor(max_workers=4) as executor:
        verdicts = list(executor.map(lambda m: filter_message(client, m["message"]), messages))
    results = [{**m, **v} for m, v in zip(messages, verdicts)]
    summary = summarize(results)
    for key, value in summary.items():
        print(f"{key}: {value}")
    output = FOLDER / "results" / f"filter-{datetime.now():%Y%m%d-%H%M%S}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"summary": summary, "results": results}, ensure_ascii=False, indent=1),
                      encoding="utf-8")
    print(f"→ {output.relative_to(FOLDER.parent)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
