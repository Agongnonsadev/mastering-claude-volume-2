"""Chapter 11: 20 questions, three ways of giving Claude the documents, one grid.

- context: the whole base in the request, read from the cache;
- rag: the 5 chunks found by BM25 (contextual if the contexts exist);
- rag-reranked: the first 10 of BM25, reranked by Claude Haiku 5.5, which keeps 3.

Run, from the python/ folder:
    python -m ch11.evaluate_doc_assistant --max-budget 0.8
    python -m ch11.evaluate_doc_assistant --modes context --max-budget 0.3
    python -m ch11.evaluate_doc_assistant --modes context --model claude-haiku-5-5 --output trials-haiku.csv
"""

import argparse
import csv
import statistics
from dataclasses import asdict, dataclass

import anthropic

from ch11.shared import FOLDER, bm25_index, load_questions
from comptoir import doc_assistant
from comptoir.knowledge import load_knowledge
from comptoir.retrieval import rerank

MODES = ("context", "rag", "rag-reranked")


@dataclass
class Trial:
    mode: str
    case: str
    passed: bool
    reasons: str
    to_review: str
    answer: str
    sources: str
    chunks_sent: int
    input_tokens: int
    cache_written: int
    cache_read: int
    output_tokens: int
    cost_dollars: float
    reranking_cost: float
    latency_s: float


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--modes", nargs="+", choices=MODES, default=list(MODES))
    parser.add_argument("--max-budget", type=float, default=0.8)
    parser.add_argument("--model", default=None, help="the model that answers (by default, the Comptoir's)")
    parser.add_argument("--output", default="trials.csv")
    parser.add_argument("--no-thinking", action="store_true", help="Claude Haiku 5.5: answer without thinking")
    parser.add_argument("--max-tokens", type=int, default=doc_assistant.MAX_TOKENS)
    parser.add_argument("--prompt", default="v1", help="the version of the document assistant's prompt")
    parser.add_argument("--no-citations", action="store_true", help="without citations: the sources are not graded")
    args = parser.parse_args()

    client = anthropic.Anthropic()
    base, prompt = load_knowledge(), doc_assistant.load_prompt(args.prompt)
    # Measured (ch11.measure_retrieval): on this base, contextual BM25 does no better.
    index = bm25_index(contextual=False)
    trials, spent = [], 0.0
    for mode in args.modes:
        for case in load_questions():
            if spent >= args.max_budget:
                print(f"Budget of ${args.max_budget} reached: stopping.")
                break
            retrieval_cost = 0.0
            if mode == "context":
                chunks, cache = base, True
            elif mode == "rag":
                chunks, cache = [c for c, _ in index.search(case.question, k=5)], False
            else:
                candidates = [c for c, _ in index.search(case.question, k=10)]
                (chunks, retrieval_cost), cache = rerank(client, case.question, candidates, keep=3), False
            answer = doc_assistant.answer(client, case.question, chunks, prompt, cache=cache, mode=mode, model=args.model,
                                          no_thinking=args.no_thinking, max_tokens=args.max_tokens,
                                          with_citations=not args.no_citations)
            reasons = doc_assistant.score_doc_answer(case, answer, require_sources=not args.no_citations)
            spent += answer.cost.dollars + retrieval_cost
            trials.append(Trial(mode, case.id, not reasons, "; ".join(reasons), case.to_review, answer.text,
                                " ".join(answer.sources), len(chunks), answer.cost.input,
                                answer.cost.cache_write, answer.cost.cache_read, answer.cost.output,
                                answer.cost.dollars, round(retrieval_cost, 6), answer.latency_s))

    output = FOLDER / "results" / args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(Trial.__dataclass_fields__))
        writer.writeheader()
        writer.writerows(asdict(t) for t in trials)

    print(f"{'mode':14} {'success':>9} {'cost/answer':>13} {'total cost':>11} {'median lat.':>13} {'avg input':>12}")
    for mode in dict.fromkeys(t.mode for t in trials):
        g = [t for t in trials if t.mode == mode]
        print(f"{mode:14} {sum(t.passed for t in g):>5}/{len(g):<3} {statistics.mean(t.cost_dollars + t.reranking_cost for t in g):>13.5f} "
              f"{sum(t.cost_dollars + t.reranking_cost for t in g):>11.4f} {statistics.median(t.latency_s for t in g):>12.1f}s "
              f"{statistics.mean(t.input_tokens + t.cache_written + t.cache_read for t in g):>12.0f}")
    print("\nFailures according to the code:")
    for t in trials:
        if not t.passed:
            print(f"  {t.mode:13} {t.case:16} {t.reasons}")
    print(f"\nSpent on the answers: ${spent:.4f} (reranking included). "
          f"Answers to review: {output}")


if __name__ == "__main__":
    main()
