"""Retrieval: BM25, embeddings, rank fusion, reranking and context by Claude, without a paid call."""

import io
import json
from types import SimpleNamespace

import pytest
from anthropic.types import Usage

from comptoir import retrieval
from comptoir.knowledge import Chunk, load_knowledge
from comptoir.retrieval import (BM25Index, VectorIndex, context_request, contextualize, fuse, recall,
                                rerank, reranking_request, voyage_embedder, words)


@pytest.fixture(autouse=True)
def log(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.LOG", str(tmp_path / "calls.jsonl"))


def chunk(id, text):
    return Chunk(id, "doc", id, text)


def test_the_words_of_a_question():
    assert words("Are you open on Sundays?") == ["open", "sunday"]
    # The plural is brought back to the singular: only the same form on both sides counts.
    assert words("The bottles and the price") == words("the bottle, the prices") == ["bottle", "price"]


def test_bm25_finds_the_exact_word():
    results = [c.id for c, _ in BM25Index(load_knowledge()).search("Do you deliver to Godomey?", k=3)]
    # “Godomey” appears only in the zones page: it comes first. The FAQ question on deliveries
    # outside Cotonou, shorter, which shares “deliver” with the question, comes second.
    assert results[:2] == ["kb://delivery-zones#outside-cotonou", "kb://faq#do-you-deliver-outside-cotonou"]


def test_bm25_a_rare_word_counts_more_than_a_common_word():
    index = BM25Index([chunk("a", "juice juice juice"), chunk("b", "juice soursop"), chunk("c", "juice pineapple")])
    assert index.search("juice soursop", k=1)[0][0].id == "b"
    assert index.search("the and of") == []  # only stop words: no result, rather than a random one


def test_embeddings_search_by_meaning():
    vectors = {"delivery": [1.0, 0.0], "payment": [0.0, 1.0], "when do you deliver": [0.9, 0.1]}
    calls = []

    def embed(texts, input_type):
        calls.append(input_type)
        return [vectors[t.split()[-1]] if t.split()[-1] in vectors else vectors[t] for t in texts]

    index = VectorIndex([chunk("d", "delivery"), chunk("p", "payment")], embed)
    assert index.search("when do you deliver", k=1)[0][0].id == "d"
    assert calls == ["document", "query"]  # Voyage tells documents from questions


def test_the_voyage_embedder_calls_mongodb_s_api(monkeypatch):
    seen = {}

    def fake_urlopen(request, timeout):
        seen["url"], seen["headers"], seen["body"] = request.full_url, dict(request.headers), json.loads(request.data)
        response = {"data": [{"index": 1, "embedding": [0.0, 1.0]}, {"index": 0, "embedding": [1.0, 0.0]}]}
        return io.BytesIO(json.dumps(response).encode())

    monkeypatch.setattr(retrieval.urllib.request, "urlopen", fake_urlopen)
    vectors = voyage_embedder(key="test-key")(["a", "b"], "document")
    assert vectors == [[1.0, 0.0], [0.0, 1.0]]  # put back in the order of the texts
    assert seen["url"] == "https://ai.mongodb.com/v1/embeddings"
    assert seen["headers"]["Authorization"] == "Bearer test-key"
    assert seen["body"] == {"input": ["a", "b"], "model": "voyage-4", "input_type": "document"}


def test_rank_fusion():
    a, b, c = chunk("a", ""), chunk("b", ""), chunk("c", "")
    lexical = [(a, 12.0), (b, 3.0)]
    semantic = [(b, 0.91), (c, 0.90)]
    fusion = fuse(lexical, semantic, keep=3)
    assert [x.id for x, _ in fusion] == ["b", "a", "c"]  # b, well placed twice, comes first


def test_recall():
    assert recall([(chunk("a", ""), 1.0)], ["x", "a"]) and not recall([], ["a"])


class FakeClient:
    def __init__(self, *texts):
        self.messages, self.texts, self.requests = self, list(texts), []

    def create(self, **request):
        self.requests.append(request)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=self.texts.pop(0))],
                               usage=Usage(input_tokens=100, output_tokens=20), _request_id="req")


def test_reranking_discards_unknown_ids():
    candidates = [chunk("a", "one"), chunk("b", "two"), chunk("c", "three")]
    client = FakeClient(json.dumps({"relevant": ["c", "unknown", "a", "c"]}))
    chosen, price = rerank(client, "?", candidates, keep=3)
    assert [c.id for c in chosen] == ["c", "a"]
    assert price == pytest.approx((100 * 0.10 + 20 * 0.50) / 1e6)  # Haiku 5.5
    assert client.requests[0]["output_config"]["format"]["type"] == "json_schema"
    assert rerank(FakeClient(), "?", []) == ([], 0.0)


def test_the_reranking_request_asks_for_no_answer():
    request = reranking_request("Do you deliver?", [chunk("a", "text")], 3)
    assert request["model"] == "claude-haiku-5-5"
    assert '<passage id="a">' in request["messages"][0]["content"]


def test_the_document_to_contextualize_is_cached():
    request = context_request("The whole document.", chunk("a", "A passage."))
    document, instruction = request["messages"][0]["content"]
    assert document["cache_control"] == {"type": "ephemeral"} and "The whole document." in document["text"]
    assert "cache_control" not in instruction and "A passage." in instruction["text"]


def test_contextualize_one_call_per_chunk():
    client = FakeClient(" Situates a. ", "Situates b.")
    contexts, usages = contextualize(client, "doc", [chunk("a", "x"), chunk("b", "y")])
    assert contexts == {"a": "Situates a.", "b": "Situates b."} and len(usages) == 2
    # The same document, identical, in each request: that is what allows reading from the cache.
    assert client.requests[0]["messages"][0]["content"][0] == client.requests[1]["messages"][0]["content"][0]
