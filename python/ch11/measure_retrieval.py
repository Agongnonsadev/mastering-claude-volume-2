"""Chapter 11: does the retrieval find the right chunk? Recall at 1, 3 and 5, without a call to Claude.

For each question whose answer is in the documents, we check whether one of the expected
chunks is in the first k results. Indexes compared: BM25 on the raw chunks, BM25 on the
contextualized chunks (if ch11.contextualize has been run), and, if VOYAGE_API_KEY is set,
Voyage AI's embeddings and hybrid search (rank fusion).

Run, from the python/ folder:  python -m ch11.measure_retrieval
"""

import os

from ch11.shared import contextualized_base, load_questions
from comptoir.knowledge import load_knowledge
from comptoir.retrieval import BM25Index, VectorIndex, fuse, recall, voyage_embedder


def main() -> None:
    cases = [c for c in load_questions() if not c.absent]
    searchers = {"BM25": BM25Index(load_knowledge()).search}
    contextualized = contextualized_base()
    if contextualized:
        searchers["contextual BM25"] = BM25Index(contextualized).search
    if os.environ.get("VOYAGE_API_KEY"):
        vectors = VectorIndex(contextualized or load_knowledge(), voyage_embedder())
        bm25 = BM25Index(contextualized or load_knowledge())
        searchers["embeddings"] = vectors.search
        searchers["hybrid"] = lambda q, k=5: fuse(bm25.search(q, 20), vectors.search(q, 20), keep=k)

    print(f"{len(cases)} questions whose answer is in the documents\n")
    print(f"{'index':18} {'recall@1':>9} {'recall@3':>9} {'recall@5':>9}")
    for name, search in searchers.items():
        rates = [sum(recall(search(c.question, k), c.sources) for c in cases) / len(cases) for k in (1, 3, 5)]
        print(f"{name:18} " + " ".join(f"{r:>9.0%}" for r in rates))
        missed = [c.id for c in cases if not recall(search(c.question, 5), c.sources)]
        if missed:
            print(f"{'':18} outside the top 5: {', '.join(missed)}")


if __name__ == "__main__":
    main()
