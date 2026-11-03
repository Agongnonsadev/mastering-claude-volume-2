"""Awa's base: splitting, stable IDs, search_result blocks and cache breakpoint."""

import json
from pathlib import Path

from comptoir.knowledge import anchor, load_knowledge, result_block, result_blocks, split, with_contexts

DOCUMENT = """# Frequently asked questions

Fictional document.

## Are you open on Sundays?

No. On Sundays, the workshop is closed.

## How do I pay?

By Mobile Money.

In cash too.
"""


def test_the_anchor_of_a_title():
    assert anchor("Are you open on Sundays?") == "are-you-open-on-sundays"
    assert anchor("Délices d'Awa's events") == "delices-d-awa-s-events"


def test_one_section_per_chunk():
    chunks = split(DOCUMENT, "faq")
    assert [c.id for c in chunks] == ["kb://faq#are-you-open-on-sundays", "kb://faq#how-do-i-pay"]
    assert chunks[0].title == "Frequently asked questions — Are you open on Sundays?"
    assert chunks[1].text == "By Mobile Money.\n\nIn cash too."


def test_a_section_too_long_is_cut_with_overlap():
    paragraphs = [f"Paragraph {i} " + "x" * 80 for i in range(6)]
    chunks = split("# Doc\n\n## Long\n\n" + "\n\n".join(paragraphs), "doc", max_size=250)
    assert len(chunks) > 1
    assert chunks[0].id == "kb://doc#long-1"
    # Each part takes up the last paragraph of the previous one.
    for before, after in zip(chunks, chunks[1:]):
        assert after.text.startswith(before.text.split("\n\n")[-1])


def test_awa_s_base():
    base = load_knowledge()
    ids = [c.id for c in base]
    assert len(base) == 41 and len(set(ids)) == 41
    assert ids == [c.id for c in load_knowledge()]  # stable order, condition of the cache
    assert "kb://delivery-zones#outside-cotonou" in ids


def test_the_expected_sources_of_the_questions_exist():
    questions = json.loads((Path(__file__).parents[1] / "ch11" / "questions.json").read_text(encoding="utf-8"))
    ids = {chunk.id for chunk in load_knowledge()}
    expected = {s for q in questions for s in q.get("sources", [])}
    assert expected <= ids, expected - ids


def test_a_search_result_block():
    chunk = split(DOCUMENT, "faq")[1]
    block = result_block(chunk)
    assert block["type"] == "search_result" and block["source"] == "kb://faq#how-do-i-pay"
    assert block["citations"] == {"enabled": True}
    assert block["content"] == [{"type": "text", "text": "By Mobile Money."}, {"type": "text", "text": "In cash too."}]
    assert "cache_control" not in block


def test_the_cache_breakpoint_is_on_the_last_block_only():
    blocks = result_blocks(split(DOCUMENT, "faq"), cache=True)
    assert [("cache_control" in b) for b in blocks] == [False, True]
    assert all("cache_control" not in b for b in result_blocks(split(DOCUMENT, "faq")))


def test_the_contexts_are_added_to_the_retrieval():
    chunk = split(DOCUMENT, "faq")[0]
    situated = with_contexts([chunk], {chunk.id: "Opening hours of the shop."})[0]
    assert situated.for_retrieval().startswith("Opening hours of the shop.")
    assert result_block(situated)["content"] == result_block(chunk)["content"]  # Claude reads the text, not the context
