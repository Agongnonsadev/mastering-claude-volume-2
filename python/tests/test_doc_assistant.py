"""The document assistant: request, citations, references, grading; and the base attached to the Comptoir."""

from types import SimpleNamespace

import pytest
from anthropic.types import Usage

from comptoir import assistant, doc_assistant
from comptoir.costs import cache_duration, max_cost
from comptoir.doc_assistant import DocAnswer, DocCase, citations, score_doc_answer, text_with_references
from comptoir.knowledge import load_knowledge, result_blocks


@pytest.fixture(autouse=True)
def log(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.LOG", str(tmp_path / "calls.jsonl"))


def citation(source, text="passage"):
    return SimpleNamespace(type="search_result_location", source=source, title=f"Title {source}", cited_text=text)


def message(*blocks):
    return SimpleNamespace(content=list(blocks), usage=Usage(input_tokens=40, output_tokens=60), _request_id="req",
                           stop_reason="end_turn")


def text(t, *cited):
    return SimpleNamespace(type="text", text=t, citations=list(cited) or None)


def test_the_documents_first_the_question_at_the_end():
    base = load_knowledge()
    request = doc_assistant.build_request("Do you deliver on Sundays?", base[:3], cache=True)
    content = request["messages"][0]["content"]
    assert [b["type"] for b in content] == ["search_result"] * 3 + ["text"]
    assert "<customer_message>" in content[-1]["text"]
    assert "cache_control" in content[2] and "cache_control" not in content[-1]  # the breakpoint after the base, not on the question
    assert "cache_control" not in doc_assistant.build_request("?", base[:3], cache=False)["messages"][0]["content"][2]


def test_citations_without_duplicates():
    m = message(text("No. ", citation("kb://faq#sunday", "Closed.")), text("No delivery.", citation("kb://faq#sunday", "Closed.")),
                SimpleNamespace(type="thinking", thinking="..."))
    assert [c.source for c in citations(m)] == ["kb://faq#sunday"]


def test_numbered_references():
    m = message(text("We deliver on Mondays", citation("kb://a"), citation("kb://b")), text(", not on Sundays."),
                text(" Payment by MoMo", citation("kb://a")))
    assert text_with_references(m) == "We deliver on Mondays[1][2], not on Sundays. Payment by MoMo[1]"


def answer(t, *sources):
    return DocAnswer(t, [], None, 1.0, "req", list(sources))


def test_grading_a_question_whose_answer_is_in_the_documents():
    case = DocCase("j", "?", sources=["kb://faq#juice"], one_of=["48"])
    assert score_doc_answer(case, answer("Drink it within 48 hours.", "kb://faq#juice")) == []
    assert "none of the expected sources is cited" in score_doc_answer(case, answer("Within 48 hours."))
    assert score_doc_answer(case, answer("Quickly.", "kb://faq#juice")) == ["none of: 48"]


def test_grading_a_question_without_an_answer_in_the_documents():
    case = DocCase("organic", "?", absent=True)
    assert score_doc_answer(case, answer("I can't find this information in our documents; I'm passing it on to Awa.")) == []
    assert score_doc_answer(case, answer("Yes, they are organic.")) == [
        "does not say the information is missing", "does not offer to pass it on to Awa"]


def test_health_refers_to_a_professional():
    case = DocCase("d", "?", sources=["kb://s"], one_of=["30 g"], refer=True)
    assert score_doc_answer(case, answer("30 g; ask a health professional.", "kb://s")) == []
    assert score_doc_answer(case, answer("30 g.", "kb://s")) == ["does not refer to a health professional"]


def test_answer_returns_the_sources_and_the_cost():
    class Client:
        def __init__(self):
            self.messages = self

        def create(self, **request):
            return message(text("On Monday", citation("kb://faq#sunday")))

    r = doc_assistant.answer(Client(), "?", load_knowledge()[:2])
    assert r.sources == ["kb://faq#sunday"] and r.text == "On Monday[1]" and r.cost.input == 40


# --- The base attached to the Comptoir (assistant.build_request) --------------------------------

def test_the_base_at_the_head_of_the_first_message_only():
    blocks = result_blocks(load_knowledge()[:2], cache=True)
    history = [{"role": "user", "content": "<customer_message>\nHello\n</customer_message>"},
               {"role": "assistant", "content": [{"type": "text", "text": "Hello!"}]}]
    request = assistant.build_request("And on Sundays?", history=history, cache=True, knowledge=blocks)
    first, last = request["messages"][0], request["messages"][-1]
    assert [b["type"] for b in first["content"]] == ["search_result", "search_result", "text"]
    assert isinstance(last["content"], str)
    assert history[0]["content"].startswith("<customer_message>")  # the history is not modified
    assert request["cache_control"] == {"type": "ephemeral"}  # automatic cache, on top of the breakpoint after the base
    # Two turns in a row: the start of the request is identical, byte for byte.
    following = assistant.build_request("Thanks", history=history, cache=True, knowledge=blocks)
    assert following["messages"][0] == first


def test_without_an_option_the_request_does_not_change():
    assert "cache_control" not in assistant.build_request("?")
    assert isinstance(assistant.build_request("?")["messages"][0]["content"], str)


def test_the_maximum_cost_counts_the_cache_write():
    # Sonnet 5.5: 10,000 tokens written to the cache at $2.50 (5 min) or $4 (1 h), plus 1,000 output at $10.
    assert max_cost("claude-sonnet-5-5", 10_000, 1_000, "5m") == pytest.approx(0.035)
    assert max_cost("claude-sonnet-5-5", 10_000, 1_000, "1h") == pytest.approx(0.05)
    assert max_cost("claude-sonnet-5-5", 10_000, 1_000) == pytest.approx(0.03)


def test_the_cache_duration_of_a_request():
    assert cache_duration({"messages": [{"role": "user", "content": "?"}]}) is None
    assert cache_duration({"cache_control": {"type": "ephemeral"}}) == "5m"
    deep = {"messages": [{"content": [{"type": "text", "text": "x", "cache_control": {"type": "ephemeral", "ttl": "1h"}}]}],
            "cache_control": {"type": "ephemeral"}}
    assert cache_duration(deep) == "1h"
