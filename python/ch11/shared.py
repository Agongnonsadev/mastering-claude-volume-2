"""What the scripts of chapter 11 share: the base, the contexts already computed, the retrieval."""

import json
from pathlib import Path

from comptoir.doc_assistant import DocCase
from comptoir.knowledge import Chunk, load_knowledge, with_contexts
from comptoir.retrieval import BM25Index

FOLDER = Path(__file__).parent
CONTEXTS = FOLDER / "results" / "contexts.json"


def load_questions() -> list[DocCase]:
    return [DocCase.from_dict(d) for d in json.loads((FOLDER / "questions.json").read_text(encoding="utf-8"))]


def contextualized_base() -> list[Chunk] | None:
    """The base with its context sentences, if ch11.contextualize has already been run."""
    if not CONTEXTS.exists():
        return None
    return with_contexts(load_knowledge(), json.loads(CONTEXTS.read_text(encoding="utf-8")))


def bm25_index(contextual: bool = True) -> BM25Index:
    base = contextualized_base() if contextual else None
    return BM25Index(base or load_knowledge())
