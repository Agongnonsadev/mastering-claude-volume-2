"""Finding the right passages when the base no longer fits in the context (chapter 11).

- BM25Index: lexical search, which finds the exact words (“Godomey”, “48 hours”).
- VectorIndex: search by meaning, with embeddings. Anthropic does not provide any:
  the function that computes them is passed as a parameter (Voyage AI, or a fake one for the tests).
- fuse: hybrid search, which combines several rankings (rank fusion).
- rerank: Claude rereads the best candidates and keeps the most useful.
- contextualize: Claude writes, for each chunk, the sentence that situates it in its document
  (Contextual Retrieval), reading the document from the cache.

Everything is in pure Python: a base of a few thousand chunks needs neither a vector
database nor a search library.
"""

import json
import math
import os
import re
import unicodedata
import urllib.request
from collections import Counter
from collections.abc import Callable

from comptoir.costs import cost
from comptoir.knowledge import Chunk
from comptoir.log import log_call

# Words too frequent to help find anything. The French ones too: the Comptoir answers
# customers who write in French.
STOP_WORDS = set("""
a about am an and any are as at be been but by can could did do does for from had has have how i if in
into is it its me my no not of on or our so than that the their them then there these they this to us
was we were what when where which who why will with would you your
au aux avec ce ces cet cette d dans de des du elle en est et etre il ils j je l la le les leur
leurs lui m ma mais me mes mon n ne nos notre nous on ou par pas pour qu que quel quelle quelles
quels qui s sa se ses si son sont sur t ta te tes ton tu un une vos votre vous y c ca est-ce
""".split())

Ranking = list[tuple[Chunk, float]]


def words(text: str) -> list[str]:
    """Lowercase, without accents, without stop words, and a simple plural brought back to the singular."""
    plain = unicodedata.normalize("NFD", text).encode("ascii", "ignore").decode().lower()
    result = []
    for word in re.findall(r"[a-z0-9]+", plain):
        if word in STOP_WORDS:
            continue
        if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
            word = word[:-1]
        result.append(word)
    return result


class BM25Index:
    """BM25: the frequency of a word in the chunk counts, but less and less (k1), rare
    words count more than common words (idf), and a long chunk does not win
    just because it is long (b)."""

    def __init__(self, chunks: list[Chunk], k1: float = 1.5, b: float = 0.75):
        self.chunks, self.k1, self.b = chunks, k1, b
        self.terms = [Counter(words(c.for_retrieval())) for c in chunks]
        self.lengths = [sum(t.values()) for t in self.terms]
        self.average_length = sum(self.lengths) / len(chunks) if chunks else 0
        frequencies = Counter(word for t in self.terms for word in t)
        n = len(chunks)
        self.idf = {word: math.log(1 + (n - f + 0.5) / (f + 0.5)) for word, f in frequencies.items()}

    def score(self, i: int, question: list[str]) -> float:
        terms, length = self.terms[i], self.lengths[i]
        total = 0.0
        for word in question:
            f = terms.get(word, 0)
            if f:
                norm = 1 - self.b + self.b * length / self.average_length
                total += self.idf[word] * f * (self.k1 + 1) / (f + self.k1 * norm)
        return total

    def search(self, question: str, k: int = 5) -> Ranking:
        q = words(question)
        scores = [(c, self.score(i, q)) for i, c in enumerate(self.chunks)]
        return sorted((s for s in scores if s[1] > 0), key=lambda s: -s[1])[:k]


Embedder = Callable[[list[str], str], list[list[float]]]  # (texts, "document" or "query") -> vectors


class VectorIndex:
    """Search by meaning: the question and the chunks become vectors, and we keep
    the chunks whose vector is closest to the question's."""

    def __init__(self, chunks: list[Chunk], embed: Embedder):
        self.chunks, self.embed = chunks, embed
        self.vectors = embed([c.for_retrieval() for c in chunks], "document")

    def search(self, question: str, k: int = 5) -> Ranking:
        q = self.embed([question], "query")[0]
        scores = [(c, _cosine(q, v)) for c, v in zip(self.chunks, self.vectors)]
        return sorted(scores, key=lambda s: -s[1])[:k]


def _cosine(a: list[float], b: list[float]) -> float:
    product = sum(x * y for x, y in zip(a, b))
    norms = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return product / norms if norms else 0.0


def voyage_embedder(model: str = "voyage-4", key: str | None = None,
                    url: str = "https://ai.mongodb.com/v1/embeddings") -> Embedder:
    """Voyage AI's embeddings, through MongoDB Atlas's HTTP API (key in VOYAGE_API_KEY).
    Paid per token: count the texts before indexing a large base."""
    key = key or os.environ["VOYAGE_API_KEY"]

    def embed(texts: list[str], input_type: str) -> list[list[float]]:
        body = json.dumps({"input": texts, "model": model, "input_type": input_type}).encode()
        request = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.load(response)
        return [d["embedding"] for d in sorted(data["data"], key=lambda d: d["index"])]

    return embed


def fuse(*rankings: Ranking, k: int = 60, keep: int = 5) -> Ranking:
    """Rank fusion (reciprocal rank fusion): each index gives 1 / (k + rank) to its
    chunks. We add up: a chunk well placed by two indexes comes first. Raw scores
    do not compare from one index to another; ranks do."""
    scores: dict[str, float] = {}
    by_id: dict[str, Chunk] = {}
    for ranking in rankings:
        for rank, (chunk, _) in enumerate(ranking, start=1):
            scores[chunk.id] = scores.get(chunk.id, 0.0) + 1 / (k + rank)
            by_id[chunk.id] = chunk
    best = sorted(scores.items(), key=lambda s: -s[1])[:keep]
    return [(by_id[i], s) for i, s in best]


# --- Claude at the service of retrieval ---------------------------------------------------

AUXILIARY_MODEL = "claude-haiku-5-5"  # small, high-volume tasks: ranking, situating

RERANKING_SCHEMA = {
    "type": "object",
    "properties": {"relevant": {"type": "array", "items": {"type": "string"}}},
    "required": ["relevant"],
    "additionalProperties": False,
}


def reranking_request(question: str, candidates: list[Chunk], keep: int,
                      model: str = AUXILIARY_MODEL) -> dict:
    passages = "\n\n".join(
        f'<passage id="{c.id}">\n{c.title}\n{c.text}\n</passage>' for c in candidates)
    return {
        "model": model,
        "max_tokens": 500,
        "system": ("You rank passages of the Délices d'Awa documentation by their usefulness for "
                   "answering a customer's question. You do not answer the question."),
        "messages": [{"role": "user", "content": (
            f"{passages}\n\n<question>{question}</question>\n\n"
            f"Give the IDs of at most {keep} passages that help answer, from the most useful to the "
            "least useful. If none helps, return an empty list.")}],
        "output_config": {"format": {"type": "json_schema", "schema": RERANKING_SCHEMA}},
    }


def rerank(client, question: str, candidates: list[Chunk], keep: int = 3,
           model: str = AUXILIARY_MODEL) -> tuple[list[Chunk], float]:
    """Claude rereads the candidates and returns the most useful, in order, with the cost in dollars.
    An unknown ID is discarded: the code does not take on trust a list produced by
    a model."""
    if not candidates:
        return [], 0.0
    request = reranking_request(question, candidates, keep, model)
    message = client.messages.create(**request)
    price = cost(model, message.usage)
    log_call(message._request_id, model, price, prompt="reranking")
    text = "".join(b.text for b in message.content if b.type == "text")
    by_id = {c.id: c for c in candidates}
    chosen = [i for i in json.loads(text)["relevant"] if i in by_id]
    return [by_id[i] for i in dict.fromkeys(chosen)][:keep], price.dollars


CONTEXT_INSTRUCTION = (
    "Here is a passage from this document:\n<passage>\n{passage}\n</passage>\n"
    "Write a short sentence that situates this passage within the whole document, so that it is "
    "found more easily in a search. Answer only with this sentence."
)


def context_request(document: str, chunk: Chunk, model: str = AUXILIARY_MODEL) -> dict:
    """The whole document first, with a cache point; the passage next. From the second
    passage to the last, the document is read from the cache, at a fraction of the price."""
    return {
        "model": model,
        "max_tokens": 200,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": f"<document>\n{document}\n</document>",
             "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": CONTEXT_INSTRUCTION.format(passage=chunk.text)},
        ]}],
    }


def contextualize(client, document: str, chunks: list[Chunk],
                  model: str = AUXILIARY_MODEL) -> tuple[dict[str, str], list]:
    """One context sentence per chunk. The calls follow one another, one by one: a cache
    entry is only available once the first response has started. Also returns the usages,
    to check that the cache did its job."""
    contexts, usages = {}, []
    for chunk in chunks:
        message = client.messages.create(**context_request(document, chunk, model))
        log_call(message._request_id, model, cost(model, message.usage), prompt="context")
        contexts[chunk.id] = "".join(b.text for b in message.content if b.type == "text").strip()
        usages.append(message.usage)
    return contexts, usages


def recall(ranking: Ranking, expected: list[str]) -> bool:
    """Does the ranking contain at least one of the expected chunks? (recall at k)"""
    return any(c.id in expected for c, _ in ranking)
