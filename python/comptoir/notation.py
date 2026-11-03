"""Grade an answer of the Comptoir with criteria written in advance (chapter 3).

Each case says what the answer must contain, what it must not contain, and whether it
must offer to pass the request on to Awa. What the code cannot judge is flagged
for a human review. Chapter 17 will go much further.
"""

import re
import unicodedata
from dataclasses import dataclass, field

# Separators found between digits: a thousands comma, and the spaces of a French customer
# (normal, non-breaking, narrow non-breaking).
_SEPARATORS_BETWEEN_DIGITS = re.compile(r"(?<=\d),(?=\d{3}(?!\d))|(?<=\d)[   ](?=\d)")
_END_OF_SENTENCE = re.compile(r"[.!?…]+(?=\s|$)")
# “Hello!”, “Good evening, madam!”, “Bonjour !” at the top of an answer: a courtesy, not a sentence.
# Added in chapter 5: the example of prompt v1 itself starts with a greeting.
_GREETING = re.compile(r"^(hello|hi|good (morning|afternoon|evening)|bonjour|bonsoir)\b[^.!?…]{0,25}[.!]\s+",
                       re.IGNORECASE)


def normalize(text: str) -> str:
    """Lowercase, straight apostrophes, “2,500” and “2500” written the same way."""
    text = unicodedata.normalize("NFC", text).lower().replace("’", "'")
    return _SEPARATORS_BETWEEN_DIGITS.sub("", text)


def count_sentences(text: str) -> int:
    text = _GREETING.sub("", text.strip(), count=1)
    return max(1, len(_END_OF_SENTENCE.findall(text.strip()))) if text.strip() else 0


@dataclass
class Case:
    id: str
    question: str
    must_contain: list[str] = field(default_factory=list)       # all required
    one_of: list[str] = field(default_factory=list)             # at least one
    must_not_contain: list[str] = field(default_factory=list)
    must_not_match: list[str] = field(default_factory=list)     # regular expressions
    must_pass_on: bool = False
    max_sentences: int = 3
    to_review: str = ""   # what a human must check, if the code cannot judge it

    @classmethod
    def from_dict(cls, d: dict) -> "Case":
        return cls(**d)


@dataclass
class Grade:
    passed: bool
    reasons: list[str]
    to_review: str = ""


PASS_ON_WORDS = ("awa", "pass on", "passed on", "passing", "forward")


def grade(case: Case, answer: str) -> Grade:
    text = normalize(answer)
    reasons = []

    for expected in case.must_contain:
        if normalize(expected) not in text:
            reasons.append(f"missing “{expected}”")
    if case.one_of and not any(normalize(a) in text for a in case.one_of):
        reasons.append(f"none of: {', '.join(case.one_of)}")
    for forbidden in case.must_not_contain:
        if normalize(forbidden) in text:
            reasons.append(f"contains “{forbidden}”")
    for pattern in case.must_not_match:
        if re.search(pattern, text):
            reasons.append(f"matches {pattern}")
    if case.must_pass_on and not any(w in text for w in PASS_ON_WORDS):
        reasons.append("does not offer to pass it on to Awa")
    if count_sentences(answer) > case.max_sentences:
        reasons.append(f"more than {case.max_sentences} sentences")

    return Grade(passed=not reasons, reasons=reasons, to_review=case.to_review)
