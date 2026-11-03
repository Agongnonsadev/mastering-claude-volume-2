"""Awa's knowledge base: Markdown documents, split into citable sections (chapter 11).

Each section becomes a “chunk” with a stable ID, for example
kb://faq#are-you-open-on-sundays. These IDs come back in the citations:
you know where each statement comes from, and the test checks it.

The same base serves two uses: whole in the context, cached; or in chunks
chosen by a search (comptoir/retrieval.py), when it becomes too big.
"""

import re
import unicodedata
from dataclasses import dataclass, replace
from pathlib import Path

FOLDER = Path(__file__).parent / "knowledge"
MAX_SIZE = 1200  # characters per chunk; beyond that, a section is cut between two paragraphs


@dataclass(frozen=True)
class Chunk:
    id: str            # kb://<document>#<section>, stable as long as the title does not change
    document: str      # the file's name, without extension
    title: str         # “Frequently asked questions — Are you open on Sundays?”
    text: str
    context: str = ""  # a sentence that situates the chunk in its document (Contextual Retrieval)

    def for_retrieval(self) -> str:
        """What the indexes read: the context if it exists, the title, then the text."""
        return " ".join(p for p in (self.context, self.title, self.text) if p)


def anchor(title: str) -> str:
    """“Are you open on Sundays?” -> “are-you-open-on-sundays”."""
    plain = unicodedata.normalize("NFD", title).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")


def _paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def split(markdown: str, document: str, max_size: int = MAX_SIZE) -> list[Chunk]:
    """One “##” section per chunk. A section that is too long is cut between two paragraphs,
    and each part takes up the last paragraph of the previous one: a sentence cut off from its
    context is badly retrieved."""
    document_title = re.search(r"^# (.+)$", markdown, re.M).group(1).strip()
    sections = re.split(r"^## ", markdown, flags=re.M)[1:]
    chunks = []
    for section in sections:
        title, _, body = section.partition("\n")
        title = title.strip()
        paragraphs = _paragraphs(body)
        parts, current = [], []
        for p in paragraphs:
            if current and len("\n\n".join(current + [p])) > max_size:
                parts.append(current)
                current = [current[-1]]  # overlap of one paragraph
            current.append(p)
        if current:
            parts.append(current)
        for i, part in enumerate(parts):
            suffix = f"-{i + 1}" if len(parts) > 1 else ""
            chunks.append(Chunk(
                id=f"kb://{document}#{anchor(title)}{suffix}",
                document=document,
                title=f"{document_title} — {title}",
                text="\n\n".join(part),
            ))
    return chunks


def load_knowledge(folder: Path = FOLDER) -> list[Chunk]:
    """All the chunks, in a stable order: that of the file names, then of the sections.
    The order matters: the cache requires an identical beginning of request, byte for byte."""
    chunks = []
    for file in sorted(folder.glob("*.md")):
        chunks.extend(split(file.read_text(encoding="utf-8"), file.stem))
    ids = [c.id for c in chunks]
    duplicates = {i for i in ids if ids.count(i) > 1}
    if duplicates:
        raise ValueError(f"Duplicate IDs in the knowledge base: {sorted(duplicates)}")
    return chunks


def with_contexts(chunks: list[Chunk], contexts: dict[str, str]) -> list[Chunk]:
    return [replace(c, context=contexts.get(c.id, c.context)) for c in chunks]


def cache_control(cache: bool | str) -> dict | None:
    """True or "5m": 5-minute cache; "1h": one-hour cache, written at twice the price."""
    if not cache:
        return None
    return {"type": "ephemeral", "ttl": "1h"} if cache == "1h" else {"type": "ephemeral"}


def result_block(chunk: Chunk, cache: bool | str = False, citations: bool = True) -> dict:
    """A chunk as a search_result block: Claude cites it with our source and our title."""
    block = {
        "type": "search_result",
        "source": chunk.id,
        "title": chunk.title,
        # One text block per paragraph: the paragraph is the smallest citable unit.
        "content": [{"type": "text", "text": p} for p in _paragraphs(chunk.text)],
        "citations": {"enabled": citations},
    }
    if cache_control(cache):
        block["cache_control"] = cache_control(cache)
    return block


def result_blocks(chunks: list[Chunk], cache: bool | str = False, citations: bool = True) -> list[dict]:
    """The chunks as search_result blocks. With a cache, the breakpoint is set on the last one:
    everything before it, tools and system prompt included, is cached together."""
    blocks = [result_block(c, citations=citations) for c in chunks]
    if blocks and cache_control(cache):
        blocks[-1]["cache_control"] = cache_control(cache)
    return blocks
