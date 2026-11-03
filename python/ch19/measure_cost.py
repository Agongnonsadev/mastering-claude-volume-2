"""Chapter 19: the cost per conversation of the Comptoir online, and each lever measured apart.

From the python/ folder:
    python -m ch19.measure_cost --estimate                                       (free)
    python -m ch19.measure_cost --variant shipped --trials 3 --max-budget 0.2    (PAID, capped)
    python -m ch19.measure_cost --variant effort-low --trials 3 --max-budget 0.2
    python -m ch19.measure_cost --variant no-cache --trials 3 --max-budget 0.3

Eight typical conversations (ch19/conversations.json), from the simple “do you deliver to…?” to the order
confirmed by its code, go through the online service (comptoir/service.py): the conversation kept
in the database, the budget per message, the routed Comptoir. “YES {code}” is replaced by the code of the
last summary, read in the shop, as the customer would do.

Each trial starts from a fresh shop at a fixed time (the harness of chapter 17). The conversations
follow one another, as in a day: the first one writes the one-hour cache, the following ones read it.
A recorder keeps each call: model, input, cache and output tokens, cost, duration.
A variant changes only one thing compared with the shipped version.
"""

import argparse
import json
import statistics
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from ch17.harness import Recorder, environment
from comptoir.budget import Budget
from comptoir.conversations import Conversations
from comptoir.service import ComptoirService

FOLDER = Path(__file__).parent
RESULTS = FOLDER / "results" / "costs"
VARIANTS = {
    "shipped": {},                                  # Haiku 5.5, default effort (medium), one-hour cache
    "effort-low": {"comptoir_effort": "low"},       # the Comptoir's effort at low
    "no-cache": {"cache": False},                   # without the cache, to see what it brings
}
ASSUMED_COST_PER_MESSAGE = 0.003  # $: generous
TOKEN_KEYS = ("input", "cache_write", "cache_read", "output")


@dataclass
class Conversation:
    variant: str
    id: str
    trial: int
    messages: int = 0
    categories: list[str] = field(default_factory=list)
    cost_dollars: float = 0.0
    calls: int = 0
    tokens: dict = field(default_factory=dict)
    durations_ms: list[int] = field(default_factory=list)
    orders: int = 0
    errors: list[str] = field(default_factory=list)


def load_conversations() -> list[dict]:
    return json.loads((FOLDER / "conversations.json").read_text(encoding="utf-8"))


def pending_code(shop, conversation: str) -> str | None:
    pending = [code for code, status, _, _ in shop.summaries(conversation) if status == "pending"]
    return pending[-1] if pending else None


def play(service: ComptoirService, recorder: Recorder, scenario: dict, variant: str, trial: int) -> Conversation:
    result = Conversation(variant, scenario["id"], trial)
    before = len(recorder.calls)
    conversation, _, _ = service.open(None)
    for message in scenario["messages"]:
        if "{code}" in message:
            code = pending_code(service.shop, conversation)
            if code is None:
                result.errors.append("no summary to confirm")
                continue
            message = message.replace("{code}", code)
        turn = service.answer(conversation, message, "measurement", group="measurement")
        result.messages += 1
        result.categories.append(turn.category)
        result.cost_dollars += turn.cost_dollars
        result.durations_ms.append(turn.duration_ms)
        if turn.error:
            result.errors.append(turn.error)
    calls = recorder.calls[before:]
    result.calls = len(calls)
    result.tokens = {key: sum(c["tokens"][key] for c in calls) for key in TOKEN_KEYS}
    result.orders = sum(1 for o in service.shop.orders() if o[2] == conversation)
    result.cost_dollars = round(result.cost_dollars, 6)
    return result


def summarize(conversations: list[Conversation]) -> dict:
    costs = [c.cost_dollars for c in conversations]
    messages = sum(c.messages for c in conversations)
    durations = sorted(d for c in conversations for d in c.durations_ms)
    return {
        "conversations": len(conversations),
        "messages": messages,
        "total_cost": round(sum(costs), 4),
        "average_cost_per_conversation": round(statistics.mean(costs), 5) if costs else None,
        "average_cost_per_message": round(sum(costs) / messages, 5) if messages else None,
        "calls_per_message": round(sum(c.calls for c in conversations) / messages, 2) if messages else None,
        "tokens": {key: sum(c.tokens.get(key, 0) for c in conversations) for key in TOKEN_KEYS},
        "median_latency_s": round(durations[len(durations) // 2] / 1000, 1) if durations else None,
        "latency_p90_s": round(durations[min(len(durations) - 1, round(0.9 * (len(durations) - 1)))] / 1000, 1)
        if durations else None,
        "orders_created": sum(c.orders for c in conversations),
        "errors": [e for c in conversations for e in c.errors],
    }


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--variant", default="shipped", choices=sorted(VARIANTS))
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--max-budget", type=float, default=0.2)
    parser.add_argument("--estimate", action="store_true")
    args = parser.parse_args()
    scenarios = load_conversations()
    estimate = sum(len(s["messages"]) for s in scenarios) * args.trials * ASSUMED_COST_PER_MESSAGE
    print(f"{len(scenarios)} conversations, {sum(len(s['messages']) for s in scenarios)} messages, {args.trials} trial(s); "
          f"generous estimate: ${estimate:.2f}")
    if args.estimate:
        return 0

    from comptoir.call import make_client
    from comptoir.knowledge import load_knowledge

    client, knowledge, results, spent = make_client(), load_knowledge(), [], 0.0
    for trial in range(1, args.trials + 1):
        recorder = Recorder(client)
        service = ComptoirService(recorder, environment(), Budget(":memory:"), Conversations(), knowledge,
                                  **VARIANTS[args.variant])
        for scenario in scenarios:
            if spent >= args.max_budget:
                print(f"Stop: ceiling of ${args.max_budget} reached.")
                break
            c = play(service, recorder, scenario, args.variant, trial)
            spent += c.cost_dollars
            results.append(c)
            print(f"  {args.variant:10} {c.id:22} {trial}  ${c.cost_dollars:.5f}  {c.calls:2} calls  "
                  f"{' > '.join(c.categories)}  {'; '.join(c.errors)}")
    summary = summarize(results)
    RESULTS.mkdir(parents=True, exist_ok=True)
    output = RESULTS / f"{datetime.now():%Y%m%d-%H%M%S}-{args.variant}.json"
    output.write_text(json.dumps({"variant": args.variant, "settings": VARIANTS[args.variant], "summary": summary,
                                  "conversations": [asdict(c) for c in results]}, ensure_ascii=False, indent=1),
                      encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print(f"→ {output.relative_to(FOLDER.parent)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
