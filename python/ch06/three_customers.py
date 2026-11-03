"""Chapter 6: three customers write at the same time. One after the other, then together.

With the asynchronous client, the server does not wait idly for Claude's answer:
while one answer is arriving, it starts another. The semaphore caps
the number of simultaneous calls, to stay under the organization's rate limits.

Run, from the python/ folder:  python -m ch06.three_customers
Cost: six short calls (three questions, twice).
"""

import asyncio
import time

from anthropic import AsyncAnthropic

from comptoir import assistant, config
from comptoir.costs import cost
from comptoir.log import log_call
from comptoir.prompt import load

QUESTIONS = [
    "Hello, do you deliver to Akpakpa?",
    "How much are 6 bottles of bissap?",
    "How long does the ginger syrup keep?",
]

MAX_CONCURRENT_CALLS = 2


async def answer(client, question: str, prompt, limit: asyncio.Semaphore) -> float:
    async with limit:  # at most MAX_CONCURRENT_CALLS calls at a time
        request = assistant.build_request(question, prompt=prompt)
        message = await client.messages.create(**request)
        price = cost(request["model"], message.usage)
        log_call(message._request_id, request["model"], price, prompt=prompt.id)
        return price.dollars


async def main() -> None:
    client = AsyncAnthropic(timeout=config.TIMEOUT_S)
    prompt = load()

    start = time.perf_counter()
    one_at_a_time = asyncio.Semaphore(1)
    costs = [await answer(client, q, prompt, one_at_a_time) for q in QUESTIONS]
    print(f"One after the other: {time.perf_counter() - start:.1f} s, ${sum(costs):.4f}")

    start = time.perf_counter()
    limit = asyncio.Semaphore(MAX_CONCURRENT_CALLS)
    costs = await asyncio.gather(*(answer(client, q, prompt, limit) for q in QUESTIONS))
    print(f"Together (at most {MAX_CONCURRENT_CALLS} at a time): {time.perf_counter() - start:.1f} s, ${sum(costs):.4f}")


if __name__ == "__main__":
    asyncio.run(main())
