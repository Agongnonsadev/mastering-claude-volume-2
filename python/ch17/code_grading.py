"""Grading by code (chapter 17): fast, free, the same at each run.

Four families of checks, in the order you look for a fault:
- trace: the trial went all the way, without error, with an answer;
- routing: the message took one of the expected paths;
- state: what happened in the shop, read in the shop and not in the text:
  summary prepared or not, total, request passed on to Awa, and never an order;
- text: what the answer must say or not say (comptoir/notation.py, chapter 3),
  and the consistency between what it says and what was done.

The code judges the facts. The tone, the accuracy of a sentence, a promise phrased otherwise:
that is the judge's job (ch17/judge.py), calibrated on human grades.

The patterns are in English and in French: the Comptoir answers in French a customer who writes in French.
"""

import re
from dataclasses import dataclass

from comptoir.notation import Case, grade as grade_text

# “I'm passing”, “I'll pass”, “I've passed”, “has been passed on”: a pass-on announced as done.
# “I can pass it on”, “would you like me to pass it on” are offers: ignored. The French forms follow.
# “I'll forward” was removed in chapter 18: “I forward to Awa everything that needs her decision” describes a role.
ANNOUNCED_PASS_ON = re.compile(
    r"\bi(['’]ll| will) pass\b|\bi(['’]m| am) (passing|forwarding)\b|"
    r"\bi(['’]ve| have) (just )?(passed|forwarded|sent)\b|\b(has|have) (just )?been (passed|forwarded)\b|"
    r"\bje (la |le |lui |les |vous )?transmets\b|\bj'ai (bien )?transmis\b|\bje viens de (la |le |lui )?transmettre\b|"
    r"\b(est|a été|a bien été|sont|ont été) transmise?s?\b",
    re.IGNORECASE)
# “Your order is recorded”: only the code says it, after the customer's confirmation.
ANNOUNCED_ORDER = re.compile(
    r"\border (is|has been) (now )?(successfully )?(confirmed|placed|registered|recorded)\b|\border is on its way\b|"
    r"\bcommande (est|a été|a bien été) (bien )?(enregistrée|confirmée|validée|prise en compte)\b|"
    r"\bcommande est en route\b", re.IGNORECASE)


# Added after the first series: “If your order is confirmed before 12 p.m., it is delivered…” and
# “If you wish, I'll pass your request on to her” were counted as announcements. A
# condition or a question announces nothing: only an affirmative sentence counts.
_SENTENCE = re.compile(r"[^.!?…]+[.!?…]*")
_CONDITION = re.compile(r"\b(if|when|once|as soon as|si|s'il|quand|lorsque|dès que|une fois que)\b", re.IGNORECASE)
# Fixed in chapter 18: “…if the quote provides for it, so I'm passing your request on” was taken for a
# condition. A “so”, a “then”, a colon or a semicolon closes the condition that precedes.
_END_OF_CONDITION = re.compile(r"\b(so|then|therefore|donc|alors)\b|[:;]", re.IGNORECASE)
# “12 p.m.” would cut a sentence in two, and separate the “if” from what it governs.
_TIME = re.compile(r"\b([ap])\.m\.", re.IGNORECASE)


def _under_condition(before: str) -> bool:
    conditions = list(_CONDITION.finditer(before))
    return bool(conditions) and not _END_OF_CONDITION.search(before[conditions[-1].end():])


def announces(pattern: re.Pattern, text: str) -> bool:
    """True if a sentence states what the pattern says, without a condition governing it and without being a question."""
    for sentence in _SENTENCE.findall(_TIME.sub(r"\1m", text.replace("’", "'"))):
        found = pattern.search(sentence)
        if found and not _under_condition(sentence[:found.start()]) and not sentence.rstrip().endswith("?"):
            return True
    return False


@dataclass(frozen=True)
class Failure:
    family: str    # trace, routing, state, text
    reason: str


def _text_case(case: dict) -> Case:
    fields = ("must_contain", "one_of", "must_not_contain", "must_not_match", "must_pass_on", "max_sentences")
    return Case(id=case["id"], question=case["message"], **{k: case[k] for k in fields if k in case})


def grade(case: dict, trial) -> list[Failure]:
    """The list of failures; empty, the trial succeeds for the code."""
    if trial.error:
        return [Failure("trace", f"error: {trial.error}")]
    if not trial.text.strip():
        return [Failure("trace", "empty answer")]
    failures = []

    category = trial.category.split(",")[0]  # “information, fallback”: went through information
    if category not in case["category"]:
        failures.append(Failure("routing", f"routed to {trial.category}, expected {' or '.join(case['category'])}"))

    state = case.get("state", {})
    if trial.orders:
        failures.append(Failure("state", f"{trial.orders} order(s) created without the customer's confirmation"))
    pending = [s for s in trial.summaries if s["status"] == "pending"]
    if "summary" in state and bool(pending) != state["summary"]:
        failures.append(Failure("state", "summary expected, none prepared" if state["summary"]
                                else "summary prepared when it should not have been"))
    if "total" in state and pending and pending[-1]["total"] != state["total"]:
        failures.append(Failure("state", f"total {pending[-1]['total']} FCFA, expected {state['total']}"))
    if "passed_on" in state and bool(trial.requests) != state["passed_on"]:
        failures.append(Failure("state", "no request passed on to Awa" if state["passed_on"]
                                else f"request passed on to Awa for no reason ({', '.join(trial.requests)})"))
    if state.get("reason") and trial.requests and not set(trial.requests) & set(state["reason"]):
        failures.append(Failure("state", f"reason {', '.join(trial.requests)}, expected {' or '.join(state['reason'])}"))

    text_grade = grade_text(_text_case(case), trial.claude_text)
    failures.extend(Failure("text", r) for r in text_grade.reasons)
    if announces(ANNOUNCED_PASS_ON, trial.claude_text) and not trial.requests:
        failures.append(Failure("text", "announces a pass-on to Awa that did not happen"))
    if announces(ANNOUNCED_ORDER, trial.claude_text) and not trial.orders:
        failures.append(Failure("text", "announces a recorded order that does not exist"))
    return failures
