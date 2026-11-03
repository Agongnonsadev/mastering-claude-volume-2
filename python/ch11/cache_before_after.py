"""Chapter 11: the same questions, without cache then with, and what the usage field says.

Three experiments:
1. a prompt too short for the cache: no error, but nothing is cached;
2. five questions, the whole base in the request, without cache;
3. the same, with a cache point after the base, preceded by a warm-up (max_tokens=0).

Run, from the python/ folder:  python -m ch11.cache_before_after --max-budget 0.5
"""

import argparse
import time

import anthropic

from ch11.shared import load_questions
from comptoir import config, doc_assistant
from comptoir.costs import cost
from comptoir.knowledge import load_knowledge
from comptoir.log import log_call

HEADER = f"{'series':10} {'no.':>3} {'input':>7} {'written':>7} {'read':>7} {'output':>7} {'cost ($)':>9} {'time':>7}"


def line(series: str, number: int, price, duration: float) -> str:
    return (f"{series:10} {number:>3} {price.input:>7} {price.cache_write:>7} {price.cache_read:>7} "
            f"{price.output:>7} {price.dollars:>9.5f} {duration:>6.1f}s")


def call_claude(client, request: dict, label: str):
    start = time.perf_counter()
    message = client.messages.create(**request)
    duration = time.perf_counter() - start
    price = cost(request["model"], message.usage)
    log_call(message._request_id, request["model"], price, prompt=label)
    return price, duration


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--questions", type=int, default=5)
    parser.add_argument("--max-budget", type=float, default=0.5)
    args = parser.parse_args()

    client = anthropic.Anthropic()
    base = load_knowledge()
    prompt = doc_assistant.load_prompt()
    questions = [c.question for c in load_questions()[: args.questions]]
    spent = 0.0

    print("1. A prompt too short for the cache")
    short = {"model": config.MODEL, "max_tokens": 50,
             "system": [{"type": "text", "text": "You are the Comptoir of Délices d'Awa.",
                         "cache_control": {"type": "ephemeral"}}],
             "messages": [{"role": "user", "content": "Hello"}]}
    price, duration = call_claude(client, short, "too-short")
    spent += price.dollars
    print(f"   written to the cache: {price.cache_write}, read from the cache: {price.cache_read}, input: {price.input} "
          "(below the minimum length, the cache point is ignored, without an error)\n")

    print(HEADER)
    totals = {}
    for series, cache in (("no cache", False), ("with cache", True)):
        total = 0.0
        if cache:
            # Warm-up: the base is written to the cache before the first real question.
            warmup = doc_assistant.build_request("warm-up", base, prompt, cache=True)
            warmup["max_tokens"] = 0
            price, duration = call_claude(client, warmup, "warmup")
            print(line("warm-up", 0, price, duration))
            total += price.dollars
        for number, question in enumerate(questions, start=1):
            if spent + total >= args.max_budget:
                print(f"Budget of ${args.max_budget} reached: stopping.")
                return
            price, duration = call_claude(client, doc_assistant.build_request(question, base, prompt, cache=cache),
                                          f"{prompt.id}/{series}")
            print(line(series, number, price, duration))
            total += price.dollars
        totals[series] = total
        spent += total
    print(f"\nTotal without cache: ${totals['no cache']:.4f}; with cache, warm-up included: "
          f"${totals['with cache']:.4f}; spent by the script: ${spent:.4f}")


if __name__ == "__main__":
    main()
