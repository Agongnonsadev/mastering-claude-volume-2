"""The complaints chain and the routed Comptoir, with fake clients: no paid call."""

import json
from types import SimpleNamespace

import pytest
from anthropic.types import TextBlock, Usage

from comptoir import complaints
from comptoir.budget import Budget
from comptoir.complaints import FALLBACK, PROMISES, handle, missing
from comptoir.knowledge import load_knowledge
from comptoir.routing import RoutedComptoir
from comptoir.shop import Shop
from comptoir.trace import Trace


@pytest.fixture(autouse=True)
def settings(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.LOG", str(tmp_path / "calls.jsonl"))
    monkeypatch.setattr("comptoir.config.MODEL", "claude-sonnet-5-5")
    monkeypatch.setattr("comptoir.config.EFFORT", None)
    monkeypatch.setattr("comptoir.config.CUSTOMER_DAILY_QUOTA", 1.0)


def text(t, stop="end_turn"):
    return SimpleNamespace(content=[TextBlock(type="text", text=t)], stop_reason=stop, stop_details=None,
                           usage=Usage(input_tokens=500, output_tokens=60), _request_id="req")


class FakeClient:
    def __init__(self, *responses):
        self.messages, self.responses, self.requests = self, list(responses), []

    def create(self, **request):
        self.requests.append(request)
        return self.responses.pop(0)

    def count_tokens(self, **request):
        return SimpleNamespace(input_tokens=500)


FACTS = {"problem": "lukewarm", "product": "bissap", "when": "yesterday", "customer_request": None, "urgent": False,
         "summary": "Three lukewarm bottles."}
GOOD = {"apologizes": True, "announces_pass_on_to_awa": True, "promises_something": False,
        "gives_medical_advice": False, "critique": "nothing"}


def test_the_gate_asks_for_what_is_missing():
    assert missing(FACTS) == []
    assert missing({**FACTS, "product": None, "when": None}) == ["the product concerned", "the day of the delivery"]
    assert missing({**FACTS, "problem": "late", "product": None}) == []  # a delay has no product


def test_the_product_comes_from_the_catalog():
    choices = complaints.FACTS_SCHEMA["properties"]["product"]["anyOf"]
    assert choices[0]["enum"] == complaints.PRODUCTS and "Bissap juice" in choices[0]["enum"]
    assert choices[1] == {"type": "null"}  # “bottles” is not a product: null, and the code asks for it


def test_the_evaluator_writes_its_critique_before_ticking():
    assert list(complaints.EVALUATION_SCHEMA["properties"])[0] == "critique"
    assert complaints.EVALUATION_SCHEMA["required"][0] == "critique"


def test_the_case_of_an_enum_is_corrected():
    facts = complaints.normalize({**FACTS, "problem": "Health", "product": "Ginger Juice"})
    assert facts["problem"] == "health" and facts["product"] == "Ginger juice"


def test_a_cut_off_draft_is_rewritten_without_paying_the_evaluator():
    client = FakeClient(text(json.dumps(FACTS)), text("Sorry. Your complaint has been passed on to A", "max_tokens"),
                        text("Sorry. Passed on to Awa, reply within 24 hours."), text(json.dumps(GOOD)))
    result = handle(client, "The bottles were lukewarm.", Shop(), "c1")
    assert result.attempts == 2 and not result.fallback and len(client.requests) == 4
    assert result.critiques == ["answer stopped by max_tokens"]
    assert "<critique>" not in client.requests[2]["messages"][0]["content"]  # incomplete, not at fault
    assert result.reply == "Sorry. Passed on to Awa, reply within 24 hours."


def test_an_unreadable_extraction_does_not_stop_the_chain():
    client = FakeClient(text('{"problem": "luk', "max_tokens"), text("Sorry. Passed on to Awa, within 24 hours."),
                        text(json.dumps(GOOD)))
    shop = Shop()
    result = handle(client, "The bottles were lukewarm.", shop, "c1")
    assert result.missing == ["the product concerned", "the day of the delivery"]
    assert shop.requests()[0][3].startswith("Extraction impossible")  # Awa receives the complaint anyway


def test_the_promise_pattern():
    assert PROMISES.search("We will refund you") and PROMISES.search("a store credit of 1,000 FCFA")
    assert not PROMISES.search("we do not accept credit cards")  # the card, not the store credit: no promise


def test_a_complaint_compliant_at_the_first_attempt():
    client = FakeClient(text(json.dumps(FACTS)), text("Sorry. Passed on to Awa, reply within 24 hours."),
                        text(json.dumps(GOOD)))
    shop, trace = Shop(), Trace()
    result = handle(client, "The bottles were lukewarm.", shop, "c1", trace)
    assert result.attempts == 1 and not result.fallback and result.versions == [result.reply]
    assert [s.name for s in trace.steps] == ["extraction", "check", "pass_on", "drafting", "evaluation"]
    assert shop.requests()[0][2] == "complaint"  # always passed on to Awa


def test_a_promise_is_rejected_then_the_fallback_text():
    promise = "Sorry, we will refund you. Passed on to Awa."
    client = FakeClient(text(json.dumps({**FACTS, "urgent": True})), text(promise), text(json.dumps(GOOD)),
                        text(promise), text(json.dumps(GOOD)))
    shop = Shop()
    result = handle(client, "My son was sick.", shop, "c1")
    assert result.fallback and result.reply.startswith(FALLBACK) and "health professional" in result.reply
    assert len(result.critiques) == 2 and "refund" in result.critiques[0]
    assert "<critique>" in client.requests[3]["messages"][0]["content"]  # the 2nd draft receives the critique
    assert shop.requests()[0][2] == "urgent-complaint"


def test_the_routed_comptoir_sends_a_question_to_the_documents():
    client = FakeClient(text(json.dumps({"category": "information", "reason": "zones"})),
                        text("We don't deliver to Godomey."))
    c = RoutedComptoir(client, Shop(), Budget(), "c1", load_knowledge()[:3])
    r = c.answer("Do you deliver to Godomey?")
    assert r.category == "information" and r.text == "We don't deliver to Godomey."
    documents = client.requests[1]
    assert documents["model"] == "claude-haiku-5-5" and documents["thinking"] == {"type": "disabled"}
    assert all(b.get("citations") == {"enabled": False} for b in documents["messages"][0]["content"][:3])
    assert [s.name for s in r.trace.steps] == ["routing", "documents"]
    assert c.comptoir.history[-1]["content"][0]["text"] == "We don't deliver to Godomey."  # the thread is kept


def test_a_cut_off_answer_goes_to_the_comptoir():
    client = FakeClient(text(json.dumps({"category": "information", "reason": "?"})), text("", stop="max_tokens"),
                        text("The Comptoir answers."))
    r = RoutedComptoir(client, Shop(), Budget(), "c1", load_knowledge()[:3]).answer("A question?")
    assert r.category == "information, fallback" and r.text == "The Comptoir answers."
    assert [s.name for s in r.trace.steps] == ["routing", "documents", "comptoir"]
    # The routed Comptoir runs on config.COMPTOIR_MODEL, Claude Haiku 5.5, since chapter 17.
    assert client.requests[2]["model"] == "claude-haiku-5-5" and "tools" in client.requests[2]


class BrokenClient(FakeClient):
    """Answers the extraction, then breaks down."""

    def create(self, **request):
        if self.requests:
            raise ConnectionError("network outage")
        return super().create(**request)


def test_an_outage_during_drafting_does_not_lose_the_complaint():
    shop = Shop()
    with pytest.raises(ConnectionError):
        handle(BrokenClient(text(json.dumps(FACTS))), "The bottles were lukewarm.", shop, "c1")
    assert len(shop.requests()) == 1  # passed on before the drafting
