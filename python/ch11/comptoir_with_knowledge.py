"""Chapter 11: the Comptoir of chapter 9, with Awa's documents, without cache then with.

The same conversation, several times, with a new shop each time: a question about the
documents, a stock question, an order, the confirmation. We count the calls, the tokens
read and written in the cache, and the cost of each message.

Run, from the python/ folder:
    python -m ch11.comptoir_with_knowledge                   (without cache, then 5-minute cache)
    python -m ch11.comptoir_with_knowledge --variants 1h     (common beginning kept one hour)
"""

import argparse
import json
import re
import uuid

from comptoir import config
from comptoir.budget import Budget
from comptoir.call import make_client
from comptoir.knowledge import load_knowledge
from comptoir.orders import ComptoirOrders
from comptoir.shop import Shop

MESSAGES = [
    "Hello, how long does a juice keep once opened?",
    "Do you still have pineapple juice and soursop juice?",
    "Then 6 bottles of pineapple, delivered to Akpakpa, in the name of Mrs. Hounkpè.",
    "YES {code}",
]
VARIANTS = {"none": (False, "without cache"), "5m": (True, "5-minute cache"),
            "1h": ("1h", "common beginning kept one hour")}


def log_lines(since: int) -> list[dict]:
    try:
        with open(config.LOG, encoding="utf-8") as f:
            return [json.loads(l) for l in f][since:]
    except FileNotFoundError:
        return []


def play(cache: bool | str, name: str) -> float:
    comptoir = ComptoirOrders(make_client(), Shop(":memory:"), Budget(":memory:"), uuid.uuid4().hex,
                              prompt_version="v3", knowledge=load_knowledge(), cache=cache)
    print(f"\n=== {name} ===")
    code, total = None, 0.0
    for message_template in MESSAGES:
        text = message_template.format(code=code)
        before = len(log_lines(0))
        answer = comptoir.answer(text)
        calls = [l for l in log_lines(before) if "request" in l]
        cost = sum(l["cost_dollars"] for l in calls)
        total += cost
        print(f"\nCustomer : {text}\nComptoir : {answer.text}")
        if answer.turn and answer.turn.execution.calls:
            print(f"  tools: {', '.join(answer.turn.execution.calls)}")
        for l in calls:
            print(f"  call: input {l['input_tokens']:>6}  written {l['cache_write_tokens']:>6}  "
                  f"read {l['cache_read_tokens']:>6}  output {l['output_tokens']:>5}  ${l['cost_dollars']:.5f}")
        found = re.search(r"YES (\d{4})", answer.text)
        code = found.group(1) if found else code
    print(f"\nTotal, {name}: ${total:.4f}")
    return total


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--variants", nargs="+", choices=list(VARIANTS), default=["none", "5m"])
    args = parser.parse_args()
    # Without cache, each call reads the whole base at full price: the quota of chapter 8 ($0.15 per
    # customer per day) would stop the conversation halfway. We raise it for this measurement.
    print(f"Quota per customer raised from ${config.CUSTOMER_DAILY_QUOTA} to $1 for the measurement.")
    config.CUSTOMER_DAILY_QUOTA = 1.0
    totals = {name: play(cache, name) for cache, name in (VARIANTS[v] for v in args.variants)}
    print("\n" + "; ".join(f"{name}: ${t:.4f}" for name, t in totals.items()))


if __name__ == "__main__":
    main()
