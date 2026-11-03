"""Answering from Awa's documents, with the sources (chapter 11).

Two ways to give Claude the documents, with the same request and the same citations:
- the whole base, cached: the start of the request never changes, it is read from the
  cache at every question;
- only the chunks found by a retrieval (RAG): fewer tokens, but a start of the request
  that changes at every question, so nothing to cache.

The chunks are search_result blocks: each citation comes back with our ID
(kb://faq#…), which the code can check and display.
"""

import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from comptoir import config
from comptoir.costs import Cost, cost
from comptoir.knowledge import Chunk, result_blocks
from comptoir.log import log_call
from comptoir.notation import normalize
from comptoir.prompt import SystemPrompt, customer_message

PROMPTS_FOLDER = Path(__file__).parent / "prompts"
MAX_TOKENS = 1000


def load_prompt(version: str = "v1") -> SystemPrompt:
    text = (PROMPTS_FOLDER / f"doc_assistant_{version}.md").read_text(encoding="utf-8").strip()
    return SystemPrompt(text, f"doc_assistant-{version}")


def build_request(question: str, chunks: list[Chunk], prompt: SystemPrompt | None = None,
                  cache: bool | str = True, model: str | None = None, no_thinking: bool = False,
                  max_tokens: int = MAX_TOKENS, with_citations: bool = True) -> dict:
    """The documents first, the question at the end: it is the order Anthropic recommends for
    long documents, and the only one that allows caching (the start does not vary)."""
    prompt = prompt or load_prompt()
    content = result_blocks(chunks, cache=cache, citations=with_citations) + [{"type": "text", "text": customer_message(question)}]
    request = {
        "model": model or config.MODEL,
        "max_tokens": max_tokens,
        "system": prompt.text,
        "messages": [{"role": "user", "content": content}],
    }
    if config.EFFORT and not model:  # the effort chosen in chapter 3 applies to the Comptoir's model
        request["output_config"] = {"effort": config.EFFORT}
    if no_thinking:  # chapter 12: for Claude Haiku 5.5, which accepts not to think
        request["thinking"] = {"type": "disabled"}
    return request


@dataclass(frozen=True)
class Citation:
    source: str   # kb://faq#…
    title: str
    text: str     # the cited passage, as it is in the document


@dataclass
class DocAnswer:
    text: str
    citations: list[Citation]
    cost: Cost
    latency_s: float
    request_id: str | None
    sources: list[str] = field(default_factory=list)  # the cited IDs, without duplicates
    plain_text: str = ""  # the same text, without references: for a customer on WhatsApp
    stop: str = "end_turn"  # the stop reason: a cut-off answer is not an answer (chapter 8)


def citations(message) -> list[Citation]:
    seen, result = set(), []
    for block in message.content:
        if block.type != "text":
            continue
        for c in getattr(block, "citations", None) or []:
            if getattr(c, "type", None) != "search_result_location":
                continue
            key = (c.source, c.cited_text)
            if key not in seen:
                seen.add(key)
                result.append(Citation(c.source, c.title or "", c.cited_text))
    return result


def text_with_references(message) -> str:
    """The text of the answer, with a reference [1], [2]… after each cited passage."""
    numbers: dict[str, int] = {}
    pieces = []
    for block in message.content:
        if block.type != "text":
            continue
        pieces.append(block.text)
        sources = list(dict.fromkeys(c.source for c in getattr(block, "citations", None) or []
                                     if getattr(c, "type", None) == "search_result_location"))
        if sources:
            for s in sources:
                numbers.setdefault(s, len(numbers) + 1)
            pieces.append("".join(f"[{numbers[s]}]" for s in sources))
    return "".join(pieces).strip()


@dataclass
class DocCase:
    """A test question, written before the trials (chapter 3)."""
    id: str
    question: str
    sources: list[str] = field(default_factory=list)   # at least one must be cited
    one_of: list[str] = field(default_factory=list)    # at least one of these facts in the answer
    absent: bool = False       # the answer is not in the documents
    refer: bool = False        # health question: refer to a professional
    to_review: str = ""

    @classmethod
    def from_dict(cls, d: dict) -> "DocCase":
        return cls(**d)


# The ways of saying "I don't know" that the code recognizes. Any other wording will be
# counted as a failure, then reviewed: the grid is corrected in writing, never on the sly.
DONT_KNOW = re.compile(
    r"can't find|cannot find|can not find|couldn't find|could not find|doesn't appear|does not appear|"
    r"no information|don't have this information|do not have this information|don't have that information|"
    r"I don't know|don't specify|do not specify|don't mention|do not mention|don't say|do not say|"
    r"je ne trouve pas|ne figure pas|pas d'information|aucune information|pas cette information",
    re.IGNORECASE)


def score_doc_answer(case: DocCase, answer: DocAnswer, require_sources: bool = True) -> list[str]:
    """The reasons for the failure; an empty list if the answer passes the code's criteria."""
    text = normalize(answer.text)
    reasons = []
    if answer.stop != "end_turn":
        reasons.append(f"answer stopped by {answer.stop}")
    if case.absent:
        if not DONT_KNOW.search(answer.text):
            reasons.append("does not say the information is missing")
        if "awa" not in text:
            reasons.append("does not offer to pass it on to Awa")
        return reasons
    if require_sources and not set(case.sources) & set(answer.sources):
        reasons.append("none of the expected sources is cited")
    if case.one_of and not any(normalize(f) in text for f in case.one_of):
        reasons.append(f"none of: {', '.join(case.one_of)}")
    if case.refer and not any(w in text for w in ("professional", "doctor", "professionnel", "médecin", "medecin")):
        reasons.append("does not refer to a health professional")
    return reasons


def answer(client, question: str, chunks: list[Chunk], prompt: SystemPrompt | None = None,
           cache: bool | str = True, mode: str = "context", model: str | None = None,
           no_thinking: bool = False, max_tokens: int = MAX_TOKENS,
           with_citations: bool = True) -> DocAnswer:
    prompt = prompt or load_prompt()
    request = build_request(question, chunks, prompt, cache, model, no_thinking, max_tokens, with_citations)
    start = time.perf_counter()
    message = client.messages.create(**request)
    latency = time.perf_counter() - start
    price = cost(request["model"], message.usage)
    log_call(message._request_id, request["model"], price, prompt=prompt.id, mode=mode,
             stop_reason=message.stop_reason)
    cited = citations(message)
    plain = "".join(b.text for b in message.content if b.type == "text").strip()
    return DocAnswer(text_with_references(message), cited, price, round(latency, 2), message._request_id,
                     list(dict.fromkeys(c.source for c in cited)), plain, message.stop_reason)
