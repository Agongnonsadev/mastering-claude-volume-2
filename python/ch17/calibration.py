"""Calibrate the judge: compare its verdicts with a human's, on the same answers (chapter 17).

Three figures per criterion:
- the raw agreement: the share of answers where the judge and the human say the same thing;
- Cohen's kappa: the same agreement, once the agreement chance alone would give is removed. When
  almost all the answers are good, a judge that always says “yes” has an excellent
  raw agreement and a zero kappa: it sees nothing;
- the false “yes”: the judge lets through an answer the human rejects. That is the error that
  costs, since a judge is there to catch bad answers.

The human can be wrong too: each disagreement is reread, and settled, before correcting
the rubric.
"""

from collections import Counter
from dataclasses import dataclass, field

from ch17.judge import CRITERIA


@dataclass
class Agreement:
    criterion: str
    n: int = 0
    agreements: int = 0
    kappa: float | None = None
    false_yes: list[str] = field(default_factory=list)    # judge yes, human no
    false_no: list[str] = field(default_factory=list)     # judge no, human yes
    others: list[str] = field(default_factory=list)       # an “unknown” on one side only

    @property
    def raw_agreement(self) -> float:
        return self.agreements / self.n if self.n else 0.0


def kappa(pairs: list[tuple[str, str]]) -> float | None:
    """Cohen's kappa for two graders. None if chance is enough to explain everything (a single value)."""
    n = len(pairs)
    if not n:
        return None
    observed = sum(a == b for a, b in pairs) / n
    left, right = Counter(a for a, _ in pairs), Counter(b for _, b in pairs)
    expected = sum(left[v] * right[v] for v in set(left) | set(right)) / (n * n)
    if expected == 1:
        return None
    return (observed - expected) / (1 - expected)


def compare(human: dict[str, dict[str, str]], judge: dict[str, dict[str, str]]) -> list[Agreement]:
    """human and judge: {trial ID: {criterion: verdict}}. Only the trials graded on both sides count."""
    common = sorted(set(human) & set(judge))
    results = []
    for criterion in CRITERIA:
        agreement, pairs = Agreement(criterion), []
        for trial in common:
            h, j = human[trial].get(criterion), judge[trial].get(criterion)
            if h is None or j is None:
                continue
            pairs.append((h, j))
            agreement.n += 1
            if h == j:
                agreement.agreements += 1
            elif j == "yes" and h == "no":
                agreement.false_yes.append(trial)
            elif j == "no" and h == "yes":
                agreement.false_no.append(trial)
            else:
                agreement.others.append(trial)
        agreement.kappa = kappa(pairs)
        results.append(agreement)
    return results


def outcome(verdicts: dict[str, str]) -> str:
    if "no" in verdicts.values():
        return "failed"
    return "passed" if verdicts and all(v == "yes" for v in verdicts.values()) else "to_review"


def overall_agreement(human: dict[str, dict[str, str]], judge: dict[str, dict[str, str]]) -> tuple[int, int, list[str]]:
    """On the outcome of each answer (passed, failed, to review): agreements, total, disagreements."""
    common = sorted(set(human) & set(judge))
    disagreements = [t for t in common if outcome(human[t]) != outcome(judge[t])]
    return len(common) - len(disagreements), len(common), disagreements


def show(results: list[Agreement]) -> str:
    lines = [f"{'criterion':14} {'graded':>6} {'agreement':>9} {'kappa':>6} {'false yes':>9} {'false no':>9}"]
    for a in results:
        k = f"{a.kappa:.2f}" if a.kappa is not None else "—"
        lines.append(f"{a.criterion:14} {a.n:>6} {a.raw_agreement:>9.0%} {k:>6} {len(a.false_yes):>9} {len(a.false_no):>9}")
    return "\n".join(lines)
