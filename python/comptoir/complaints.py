"""The complaints chain: extract, check, draft, evaluate, pass on (chapter 12).

A fixed sequence, written in the code, where each call has a simple task:
1. extract the facts, with Claude Haiku 5.5 and a structured output;
2. check by code what is missing (the “gate” between two steps);
3. pass the record on to Awa, before everything else: if what follows fails, Awa has the complaint.
   No complaint is settled without her;
4. draft the reply to the customer, with Claude Sonnet 5.5;
5. evaluate this reply: the code looks for the words that promise, Claude Haiku 5.5 reviews the
   rules; a rejected reply is rewritten once, with the critique, then replaced by a
   fixed text if it fails again (evaluator and optimizer).

Each step can fail: an output cut off by max_tokens, an unreadable JSON. The code
sees it and takes over; the complaint goes to Awa in every case.
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from comptoir import config
from comptoir.costs import cost
from comptoir.log import log_call
from comptoir.prompt import customer_message, load_data
from comptoir.trace import Trace

AUXILIARY_MODEL = config.AUXILIARY_MODEL  # extraction and evaluation (chapter 12)
REPLY_PROMPT = (Path(__file__).parent / "prompts" / "complaint_v1.md").read_text(encoding="utf-8").strip()
PROBLEMS = ["damaged", "lukewarm", "wrong_item", "missing", "late", "rider", "health", "other"]

NULLABLE = {"anyOf": [{"type": "string"}, {"type": "null"}]}
# The product comes from the catalog or is not known. In free text, the extraction wrote “bottles”,
# and the gate believed the product known: the human review saw it, not the tests.
PRODUCTS = [p["name"] for p in load_data()["products"]]
PRODUCT = {"anyOf": [{"type": "string", "enum": PRODUCTS}, {"type": "null"}]}

FACTS_SCHEMA = {
    "type": "object",
    "properties": {
        "problem": {"type": "string", "enum": PROBLEMS},
        "product": PRODUCT,
        "when": NULLABLE,            # as the customer writes it: “yesterday”, “this morning”
        "customer_request": NULLABLE,
        "urgent": {"type": "boolean"},                    # health or safety: Awa is warned first
        "summary": {"type": "string"},
    },
    "required": ["problem", "product", "when", "customer_request", "urgent", "summary"],
    "additionalProperties": False,
}

# The critique first: the answer follows the order of the schema, and a box ticked before writing
# the opinion gets it wrong. Boxes first, a compliant reply was rejected 10 times out of 10; critique
# first, 0 times out of 10, and a real promise stays rejected 10 times out of 10 (measured in chapter 12).
EVALUATION_SCHEMA = {
    "type": "object",
    "properties": {
        "critique": {"type": "string"},
        "apologizes": {"type": "boolean"},
        "announces_pass_on_to_awa": {"type": "boolean"},
        "promises_something": {"type": "boolean"},
        "gives_medical_advice": {"type": "boolean"},
    },
    "required": ["critique", "apologizes", "announces_pass_on_to_awa", "promises_something",
                 "gives_medical_advice"],
    "additionalProperties": False,
}

EVALUATION_SYSTEM = (
    "You review the reply of the Comptoir of Délices d'Awa to a customer who is complaining. You check four points, "
    "without rewriting anything: the reply apologizes; it announces that the complaint is passed on to Awa; it promises "
    "nothing (no refund, no replacement, no store credit, no gift, no delay other than 24 hours); it gives no "
    "medical advice (inviting the customer to see a professional is allowed). The critique says in one sentence what "
    "must be corrected, or “nothing”.")

# What the code refuses on its own, without asking a model. “credit” alone is not enough: “we do not accept
# credit cards” promises nothing. The French pattern fell into the same trap with the word « avoir », a store
# credit but also the verb “to have” (« après avoir bu »), which its first version took for a promise.
PROMISES = re.compile(r"\brefund|\breplac(e|ed|ement)\b|\bstore credit\b|\bcredit note\b|\bfor free\b|"
                      r"\bfree of charge\b|\bon the house\b|\bgoodwill gesture\b|\bgift\b|\bcompensat",
                      re.IGNORECASE)

FALLBACK = ("We are sorry for the inconvenience. Your complaint has been passed on to Awa, who will reply "
            "within 24 hours.")
HEALTH_FALLBACK = " If any discomfort persists, see a health professional."

# Thinking included: at 400, 3 drafts out of 35 were cut off, one of them empty (measured in chapter 12).
DRAFTING_MAX_TOKENS = 1000
DRAFTING_EFFORT = config.DRAFTING_EFFORT  # low: the measurement is in comptoir/config.py

UNKNOWN_FACTS = {"problem": "other", "product": None, "when": None, "customer_request": None, "urgent": False,
                 "summary": "Extraction impossible: the complaint is to be read in the conversation."}


@dataclass
class ComplaintResult:
    reply: str
    facts: dict
    missing: list[str]
    attempts: int
    fallback: bool
    request: str | None = None     # the ID of the request recorded for Awa
    critiques: list[str] = field(default_factory=list)
    versions: list[str] = field(default_factory=list)  # each draft, kept for the review


def _text(response) -> str:
    return "".join(b.text for b in response.content if b.type == "text")


def _structured(client, model: str, system: str, content: str, schema: dict,
                label: str) -> tuple[dict | None, float]:
    """None if the output is cut off or unreadable. The cost, though, is paid: it is returned anyway."""
    request = {"model": model, "max_tokens": 600, "system": system,
               "messages": [{"role": "user", "content": content}],
               "output_config": {"format": {"type": "json_schema", "schema": schema}}}
    response = client.messages.create(**request)
    price = cost(model, response.usage)
    log_call(response._request_id, model, price, prompt=label, stop_reason=response.stop_reason)
    if response.stop_reason != "end_turn":
        return None, price.dollars
    try:
        return json.loads(_text(response)), price.dollars
    except json.JSONDecodeError:
        return None, price.dollars


def normalize(facts: dict) -> dict:
    """The case of an enum value is not guaranteed (structured outputs documentation):
    “Ginger Juice” becomes “Ginger juice” again."""
    catalog = {p.lower(): p for p in PRODUCTS}
    problem = str(facts.get("problem") or "other").lower()
    product = catalog.get(str(facts["product"]).lower()) if facts.get("product") else None
    return {**facts, "problem": problem if problem in PROBLEMS else "other", "product": product}


def extract(client, message: str) -> tuple[dict, float]:
    system = ("You read the complaint of a Délices d'Awa customer and extract its facts, without adding anything. "
              "If a piece of information is not written, set null: product is the catalog product that the customer "
              "names, or null if they do not name it. urgent is true only for a health or safety "
              "problem. The summary fits in one neutral sentence, for Awa.")
    facts, price = _structured(client, AUXILIARY_MODEL, system, customer_message(message), FACTS_SCHEMA,
                               "complaint-facts")
    # Without facts, the chain goes on: the gate will ask for everything, and Awa will read the conversation.
    return (normalize(facts) if facts else dict(UNKNOWN_FACTS)), price


def missing(facts: dict) -> list[str]:
    """The gate: what the code checks, without a model."""
    to_ask = []
    if not facts.get("product") and facts["problem"] not in ("late", "rider"):
        to_ask.append("the product concerned")
    if not facts.get("when"):
        to_ask.append("the day of the delivery")
    return to_ask


def draft(client, message: str, to_ask: list[str], critique: str | None = None,
          effort: str | None = DRAFTING_EFFORT) -> tuple[str, float, str]:
    """The text, its cost and the stop reason: a text stopped by max_tokens is incomplete."""
    content = (f"{customer_message(message)}\n\n<to_ask>{', '.join(to_ask)}</to_ask>"
               + (f"\n\n<critique>Your previous reply was rejected: {critique} Rewrite it.</critique>"
                  if critique else ""))
    request = {"model": config.MODEL, "max_tokens": DRAFTING_MAX_TOKENS, "system": REPLY_PROMPT,
               "messages": [{"role": "user", "content": content}]}
    if effort:
        request["output_config"] = {"effort": effort}
    response = client.messages.create(**request)
    price = cost(config.MODEL, response.usage)
    log_call(response._request_id, config.MODEL, price, prompt="complaint-v1", stop_reason=response.stop_reason)
    return _text(response).strip(), price.dollars, response.stop_reason


def evaluate(client, reply: str) -> tuple[list[str], float]:
    """The problems of the reply; an empty list if it follows the rules."""
    problems = [f"forbidden promise: “{m.group(0)}”" for m in [PROMISES.search(reply)] if m]
    judgment, price = _structured(client, AUXILIARY_MODEL, EVALUATION_SYSTEM, f"<answer>{reply}</answer>",
                                  EVALUATION_SCHEMA, "complaint-evaluation")
    if judgment is None:
        return problems + ["evaluation impossible"], price  # a reply that was not reviewed is not sent
    if not judgment["apologizes"]:
        problems.append("no apology")
    if not judgment["announces_pass_on_to_awa"]:
        problems.append("passing on to Awa is not announced")
    if judgment["promises_something"]:
        problems.append(f"promise: {judgment['critique']}")
    if judgment["gives_medical_advice"]:
        problems.append(f"medical advice: {judgment['critique']}")
    return problems, price


def handle(client, message: str, shop, conversation: str, trace: Trace | None = None,
           max_attempts: int = 2, effort: str | None = DRAFTING_EFFORT) -> ComplaintResult:
    trace = trace or Trace()
    with trace.step("extraction", AUXILIARY_MODEL) as s:
        facts, price = extract(client, message)
        s.record(price, f"{facts['problem']}{', urgent' if facts['urgent'] else ''}")
    with trace.step("check") as s:
        to_ask = missing(facts)
        s.record(0.0, f"to ask: {len(to_ask)}")
    with trace.step("pass_on") as s:
        reason = "urgent-complaint" if facts["urgent"] else "complaint"
        request = shop.pass_on(conversation, reason, facts["summary"])["request"]
        s.record(0.0, request)
    critiques, versions, reply, fallback, to_fix = [], [], None, False, None
    for attempt in range(1, max_attempts + 1):
        with trace.step("drafting", config.MODEL) as s:
            text, price, stop = draft(client, message, to_ask, to_fix, effort)
            versions.append(text)
            s.record(price, f"version {attempt}" + ("" if stop == "end_turn" else f", stopped by {stop}"))
        if stop != "end_turn":
            # The code alone sees that a text is cut off: no need to pay the evaluator. We rewrite without
            # a critique: the text was not at fault, only incomplete.
            critiques.append(f"answer stopped by {stop}")
            to_fix = None
            continue
        with trace.step("evaluation", AUXILIARY_MODEL) as s:
            problems, price = evaluate(client, text)
            s.record(price, "compliant" if not problems else f"rejected ({len(problems)})")
        if not problems:
            reply = text
            break
        to_fix = "; ".join(problems)
        critiques.append(to_fix)
    if reply is None:
        # The code has the last word: a fixed text, without promise, with the health advice if needed.
        reply, fallback = FALLBACK + (HEALTH_FALLBACK if facts["urgent"] else ""), True
    return ComplaintResult(reply, facts, to_ask, attempt, fallback, request, critiques, versions)
