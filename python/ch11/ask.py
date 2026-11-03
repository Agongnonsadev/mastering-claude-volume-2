"""Chapter 11: asking Awa's documents a question, and seeing where the answer comes from.

Run, from the python/ folder:
    python -m ch11.ask "Do you deliver on Sundays?"
    python -m ch11.ask --mode rag "Do you deliver to Godomey?"
"""

import argparse

import anthropic

from ch11.shared import bm25_index
from comptoir import doc_assistant
from comptoir.knowledge import load_knowledge


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("question")
    parser.add_argument("--mode", choices=["context", "rag"], default="context")
    args = parser.parse_args()

    if args.mode == "context":
        chunks, cache = load_knowledge(), True  # the whole base, cached
    else:
        chunks, cache = [c for c, _ in bm25_index(contextual=False).search(args.question, k=5)], False

    answer = doc_assistant.answer(anthropic.Anthropic(), args.question, chunks, cache=cache, mode=args.mode)
    print(answer.text, "\n")
    for number, source in enumerate(answer.sources, start=1):
        title = next(c.title for c in answer.citations if c.source == source)
        print(f"[{number}] {title}  ({source})")
    if not answer.sources:
        print("(no source cited)")
    print(f"\n[{answer.cost.input} input tokens, {answer.cost.cache_write} written to the cache, "
          f"{answer.cost.cache_read} read from the cache, {answer.cost.output} output; {answer.cost}; "
          f"{answer.latency_s} s]")


if __name__ == "__main__":
    main()
