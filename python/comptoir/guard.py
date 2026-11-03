"""The Comptoir's guards (chapter 18): what the code checks itself, whatever the model writes.

- What an answer announces, against what was done: the document assistant has no tool; if it
  writes “I'm passing your request on to Awa”, it is a promise nobody will keep. Chapter 17
  measured it (two times out of three on one case), chapter 18 reproduced it (three times out of three).
- The fields written by the customer and kept by the shop, the name and the neighborhood: they end up in
  Awa's Claude application, through the MCP server of chapter 15. Free text there would become an
  indirect injection. These are short data; the code refuses everything else, before recording.

The patterns come from the grading of chapter 17 (ch17/code_grading.py), which judges the trials; here,
they protect the customers. The two stay separate: the guard can evolve without changing the grades.
The patterns are in English and in French: the Comptoir answers in French a customer who writes in French.
"""

import re

# “I'm passing”, “I've passed”, “has been passed on”: a pass-on announced as done. “I can pass it on”,
# “would you like me to pass it on” are offers: ignored. The French forms follow.
ANNOUNCED_PASS_ON = re.compile(
    r"\bi(['’]ve| have) (passed|forwarded|sent)\b|\bi(['’]m| am) (passing|forwarding)\b|\b(has been|have been) (passed|forwarded)\b|"
    r"\bje (la |le |lui |les |vous )?transmets\b|\bj'ai (bien )?transmis\b|\bje viens de (la |le |lui )?transmettre\b|"
    r"\b(est|a été|a bien été|sont|ont été) transmise?s?\b",
    re.IGNORECASE)
_SENTENCE = re.compile(r"[^.!?…]+[.!?…]*")
_CONDITION = re.compile(r"\b(if|when|once|as soon as|si|s'il|quand|lorsque|dès que|une fois que)\b", re.IGNORECASE)
# What closes a condition: “if the quote provides for it, so I'm passing it on” is an announcement. Measured in
# chapter 18: the first version of this guard, like the grading of chapter 17, was taken in by it.
_END_OF_CONDITION = re.compile(r"\b(so|then|therefore|donc|alors)\b|[:;]", re.IGNORECASE)


def under_condition(before: str) -> bool:
    """True if a condition governs what follows: an “if” without “so”, “then”, colon or
    semicolon between it and the rest. “If you wish, I'm passing it on to her” stays an offer."""
    conditions = list(_CONDITION.finditer(before))
    return bool(conditions) and not _END_OF_CONDITION.search(before[conditions[-1].end():])


def announces_pass_on(text: str) -> bool:
    """True if a sentence states a pass-on, without a condition governing it and without being a question."""
    for sentence in _SENTENCE.findall(text.replace("’", "'")):
        found = ANNOUNCED_PASS_ON.search(sentence)
        if found and not under_condition(sentence[:found.start()]) and not sentence.rstrip().endswith("?"):
            return True
    return False


# --- The customer's fields ----------------------------------------------------------------------

MAX_NAME_LENGTH = 60
MAX_NEIGHBORHOOD_LENGTH = 40
# Letters (accents included), separated by a space, a hyphen, an apostrophe or a period:
# “Larissa Noudéhou”, “Mrs. Akpovi”, “Jean-Marc”, “N'Dah”. No digit, no colon, no bracket.
_NAME = re.compile(r"[^\W\d_]+(?:[ '’.-]+[^\W\d_]+)*\.?")
# A neighborhood can carry a number (“Zone 4”, “PK 10”): letters and digits, same separators.
_NEIGHBORHOOD = re.compile(r"[^\W_]+(?:[ '’.-]+[^\W_]+)*")
_MAX_WORDS = 6


def _problem(value: str, pattern: re.Pattern, max_length: int, what: str) -> str | None:
    value = value.strip()
    if not value:
        return f"{what} is empty"
    if len(value) > max_length or len(value.split()) > _MAX_WORDS:
        return f"{what} is too long ({len(value)} characters)"
    if not pattern.fullmatch(value):
        return f"{what} contains something other than letters{' and digits' if pattern is _NEIGHBORHOOD else ''}"
    return None


def name_problem(name: str) -> str | None:
    """None if the name is acceptable; otherwise, what is wrong, to tell Claude."""
    return _problem(name, _NAME, MAX_NAME_LENGTH, "the name")


def neighborhood_problem(neighborhood: str) -> str | None:
    return _problem(neighborhood, _NEIGHBORHOOD, MAX_NEIGHBORHOOD_LENGTH, "the neighborhood")
