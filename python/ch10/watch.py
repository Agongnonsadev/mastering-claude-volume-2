"""Chapter 10: a current-events question, with web search and its sources.

Run, from the python/ folder:
    python -m ch10.watch "Which public holidays fall in Benin in November and December 2026?"
    python -m ch10.watch --filtering "…"          (dynamic filtering of the results)
Cost: $10 per 1,000 searches (at most --max-searches), plus the tokens of the results.
"""

import argparse

import anthropic

from comptoir import config
from comptoir.server_tools import call, sources, tool_errors, web_search

SYSTEM = (
    "You help Yao, at Délices d'Awa in Cotonou, plan the schedule. Answer in English, briefly, "
    "and base each piece of information on a source you found. If the sources contradict each other or are missing, say so."
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("question")
    parser.add_argument("--max-searches", type=int, default=3)
    parser.add_argument("--filtering", action="store_true", help="dynamic filtering (web_search_20260209)")
    args = parser.parse_args()

    request = {
        "model": config.MODEL,
        "max_tokens": 3000,
        "system": SYSTEM,
        "tools": [web_search(args.max_searches, dynamic_filtering=args.filtering)],
        "messages": [{"role": "user", "content": args.question}],
    }
    result = call(anthropic.Anthropic(), request)
    print(result.text)
    print("\nSources:")
    for source in sources(result.message):
        print(f"  - {source['title']} — {source['source']}")
    for error in tool_errors(result.message):
        print(f"  ⚠ {error}")
    usage = result.message.usage
    print(f"\n{result.searches} search(es), {result.calls} call(s), {result.resumptions} resumption(s); "
          f"input {usage.input_tokens} tokens, output {usage.output_tokens}; cost ${result.cost:.4f}")


if __name__ == "__main__":
    main()
