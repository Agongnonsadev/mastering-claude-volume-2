"""Chapter 2: a call to Claude in raw HTTP, without the SDK, with the standard library only.

Run, from the python/ folder:  python -m ch02.http_call
"""

import json
import os
import urllib.request

request_body = {
    "model": "claude-sonnet-5-5",
    "max_tokens": 1000,
    "messages": [
        {"role": "user", "content": "Hello! Introduce yourself in one sentence."},
    ],
}

request = urllib.request.Request(
    "https://api.anthropic.com/v1/messages",
    data=json.dumps(request_body).encode("utf-8"),
    headers={
        "x-api-key": os.environ["ANTHROPIC_API_KEY"],  # read from the environment, never written here
        "anthropic-version": "2026-10-21",  # the API version since October 21, 2026 (chapter 21)
        "content-type": "application/json",
    },
    method="POST",
)

with urllib.request.urlopen(request, timeout=60) as response:
    request_id = response.headers.get("request-id")
    body = json.load(response)

# The response is a list of blocks: we keep only the text blocks.
text = "".join(block["text"] for block in body["content"] if block["type"] == "text")

print(text)
print("Request ID:", request_id)
print("Stop reason:", body["stop_reason"])
print("Usage:", body["usage"])
