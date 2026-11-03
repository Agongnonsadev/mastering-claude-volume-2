"""Chapter 6: the events of a stream, one by one, with the time of their arrival.

Shows what the SDK receives from the API: message_start, then for each block
content_block_start, content_block_delta events and content_block_stop, then
message_delta (stop reason, cumulative usage) and message_stop.
The ping events are absorbed by the SDK: you will not see them here.

Run, from the python/ folder:  python -m ch06.events "Which juices do you have?"
"""

import sys
import time

import anthropic

from comptoir import assistant
from comptoir.costs import cost
from comptoir.log import log_call
from comptoir.prompt import load

# The API's raw events. The SDK adds its own (text, thinking…), more convenient.
RAW = {"message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"}


def main(question: str) -> None:
    client = anthropic.Anthropic()
    prompt = load()
    request = assistant.build_request(question, prompt=prompt)
    start = time.perf_counter()
    first_text = None

    with client.messages.stream(**request) as stream:
        for event in stream:
            if event.type not in RAW:
                continue
            ms = (time.perf_counter() - start) * 1000
            if event.type == "content_block_start":
                print(f"{ms:7.0f} ms  content_block_start  (block {event.index}: {event.content_block.type})")
            elif event.type == "content_block_delta":
                if event.delta.type == "text_delta":
                    first_text = first_text or ms
                    print(f"{ms:7.0f} ms  content_block_delta  {event.delta.text!r}")
                else:
                    print(f"{ms:7.0f} ms  content_block_delta  ({event.delta.type})")
            elif event.type == "message_delta":
                print(f"{ms:7.0f} ms  message_delta        stop_reason={event.delta.stop_reason}")
            else:
                print(f"{ms:7.0f} ms  {event.type}")
        message = stream.get_final_message()
        request_id = stream.request_id

    total = (time.perf_counter() - start) * 1000
    price = cost(request["model"], message.usage)
    log_call(request_id, request["model"], price, prompt=prompt.id)
    print(f"\nFirst text after {first_text or 0:.0f} ms; full answer after {total:.0f} ms.")
    print(f"Blocks of the final message: {[b.type for b in message.content]}")
    print(f"Cost: {price}")


if __name__ == "__main__":
    main(" ".join(sys.argv[1:]) or "Which juices do you have, and at what price?")
