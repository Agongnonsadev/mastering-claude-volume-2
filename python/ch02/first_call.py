"""Chapter 2: the same call with the official SDK, and its cost.

Run, from the python/ folder:  python -m ch02.first_call
"""

import anthropic

from comptoir.costs import cost

client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment

message = client.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=1000,
    messages=[
        {"role": "user", "content": "Hello! Introduce yourself in one sentence."},
    ],
)

for block in message.content:
    if block.type == "text":
        print(block.text)

print("Request ID:", message._request_id)
print("Stop reason:", message.stop_reason)
print("Tokens:", message.usage.input_tokens, "input,", message.usage.output_tokens, "output")
print("Cost:", cost(message.model, message.usage))
