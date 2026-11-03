"""Chapter 11: writing, for each chunk of the base, the sentence that situates it in its document.

It is Anthropic's “Contextual Retrieval” method. The whole document is sent with a cache
point; from the second chunk to the last, it is read from the cache. The sentences are
kept in ch11/results/contexts.json: they are only recomputed if a document changes.

Run, from the python/ folder:  python -m ch11.contextualize
Model: Claude Haiku 5.5. Cost: about forty short calls.
"""

import json

import anthropic

from ch11.shared import CONTEXTS
from comptoir.costs import cost
from comptoir.knowledge import FOLDER, split
from comptoir.retrieval import AUXILIARY_MODEL, contextualize


def main() -> None:
    client = anthropic.Anthropic()
    all_contexts, total = {}, 0.0
    print(f"{'document':22} {'chunks':>8} {'written':>7} {'read':>7} {'input':>7} {'output':>7} {'cost ($)':>9}")
    for file in sorted(FOLDER.glob("*.md")):
        text = file.read_text(encoding="utf-8")
        chunks = split(text, file.stem)
        contexts, usages = contextualize(client, text, chunks)
        prices = [cost(AUXILIARY_MODEL, u) for u in usages]
        subtotal = sum(p.dollars for p in prices)
        total += subtotal
        print(f"{file.stem:22} {len(chunks):>8} {sum(p.cache_write for p in prices):>7} "
              f"{sum(p.cache_read for p in prices):>7} {sum(p.input for p in prices):>7} "
              f"{sum(p.output for p in prices):>7} {subtotal:>9.5f}")
        all_contexts.update(contexts)
    CONTEXTS.parent.mkdir(parents=True, exist_ok=True)
    CONTEXTS.write_text(json.dumps(all_contexts, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{len(all_contexts)} contexts written to {CONTEXTS}; total cost: ${total:.5f}")
    example = next(iter(all_contexts.items()))
    print(f"Example, {example[0]}:\n  {example[1]}")


if __name__ == "__main__":
    main()
