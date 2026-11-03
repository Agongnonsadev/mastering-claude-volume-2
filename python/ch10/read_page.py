"""Chapter 10: read a specific page, bounding what it costs.

Run, from the python/ folder:
    python -m ch10.read_page https://fr.wikipedia.org/wiki/Bissap "Summarize in three sentences."
    python -m ch10.read_page --max-read-tokens 2000 https://fr.wikipedia.org/wiki/Bissap "…"
Page reading costs only its tokens; --max-read-tokens sets the ceiling.
"""

import argparse

import anthropic

from comptoir import config
from comptoir.server_tools import call, sources, tool_errors, web_fetch


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("url")
    parser.add_argument("instruction")
    parser.add_argument("--max-read-tokens", type=int, default=8000)
    args = parser.parse_args()

    request = {
        "model": config.MODEL,
        "max_tokens": 2000,
        "tools": [web_fetch(max_uses=1, max_content_tokens=args.max_read_tokens)],
        # The address must appear in the message: Claude only reads URLs that have already
        # appeared in the conversation, never an address it would have written itself.
        "messages": [{"role": "user", "content": f"{args.instruction}\n\nPage to read: {args.url}"}],
    }
    result = call(anthropic.Anthropic(), request)
    print(result.text)
    for source in sources(result.message):
        print(f"  [source: {source['title']}]")
    for error in tool_errors(result.message):
        print(f"  ⚠ {error}")
    usage = result.message.usage
    print(f"\nInput {usage.input_tokens} tokens (reading ceiling: {args.max_read_tokens}), output {usage.output_tokens}; "
          f"cost ${result.cost:.4f}")


if __name__ == "__main__":
    main()
