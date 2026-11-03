"""Chapter 11: a cache that never serves, and the API that says why (cache diagnostics).

Deliberate mistake: the time is written in the system prompt. The beginning of the request
therefore changes at every call, and the cache is rewritten every time. The cache diagnostics
report it (system_changed). Then the fix: the time moves after the cache point, into the message.

Run, from the python/ folder:  python -m ch11.diagnose_cache
Cost: four calls with the whole base, three of which write to the cache.
"""

import time
from datetime import datetime

import anthropic

from comptoir import config, doc_assistant
from comptoir.costs import cost
from comptoir.knowledge import load_knowledge, result_blocks
from comptoir.log import log_call
from comptoir.prompt import customer_message


def request(system_prompt: str, question: str, base, previous: str | None) -> dict:
    return {
        "model": config.MODEL,
        "max_tokens": 300,
        "system": system_prompt,
        "messages": [{"role": "user", "content": result_blocks(base, cache=True)
                      + [{"type": "text", "text": customer_message(question)}]}],
        "diagnostics": {"previous_message_id": previous},
    }


def run(client, label: str, req: dict):
    message = client.beta.messages.create(**req)
    price = cost(req["model"], message.usage)
    log_call(message._request_id, req["model"], price, prompt=label)
    reason = getattr(message, "diagnostics", None)
    reason = reason.cache_miss_reason if reason is not None else None
    detail = "no divergence" if reason is None else f"{reason.type}"
    if reason is not None and getattr(reason, "cache_missed_input_tokens", None) is not None:
        detail += f" ({reason.cache_missed_input_tokens} tokens lost, estimate)"
    print(f"{label:28} written {price.cache_write:>6}  read {price.cache_read:>6}  ${price.dollars:.4f}  "
          f"diagnostics: {detail}")
    return message


def main() -> None:
    client = anthropic.Anthropic()
    base = load_knowledge()
    prompt = doc_assistant.load_prompt().text
    question = "Do you deliver on Sundays?"

    def now() -> str:
        return datetime.now().strftime("%m/%d/%Y %H:%M:%S")

    print("The mistake: the time in the system prompt")
    m1 = run(client, "1. time in the system", request(f"{prompt}\n\nIt is {now()}.", question, base, None))
    time.sleep(2)
    m2 = run(client, "2. same mistake", request(f"{prompt}\n\nIt is {now()}.", question, base, m1.id))

    print("\nThe fix: the time after the cache point, in the customer's message")
    m3 = run(client, "3. stable system", request(prompt, f"(It is {now()}.) {question}", base, m2.id))
    time.sleep(2)
    run(client, "4. stable system, again", request(prompt, f"(It is {now()}.) {question}", base, m3.id))


if __name__ == "__main__":
    main()
