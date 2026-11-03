"""The Comptoir's evaluation suite (chapter 17): run, grade, summarize, keep the record.

- the cases live in ch17/cases.json, each in a set: “improvement” to work,
  “verification” to check, only once, the chosen version;
- each series of trials goes into its own folder of ch17/results/series/, with all the
  transcripts; a line enters ch17/results/register.jsonl: the variant, the
  versions of the prompts, the fingerprint of the cases and of the grading, the results and the cost.
  Two series compare only if they received the same messages (the cases' fingerprint); their
  answers are then graded together, by the grading of the day: the code's, the references and the
  judge's rubric apply to both at once.
"""

import hashlib
import json
import statistics
import threading
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import asdict, fields
from datetime import datetime, timezone
from pathlib import Path

from ch17.code_grading import grade
from ch17.harness import Trial, Variant, run_trial
from comptoir import config, doc_assistant
from comptoir.prompt import load
from comptoir.router import PROMPT as ROUTER_PROMPT

FOLDER = Path(__file__).parent
SERIES = FOLDER / "results" / "series"
REGISTER = FOLDER / "results" / "register.jsonl"

SONNET, HAIKU = "claude-sonnet-5-5", "claude-haiku-5-5"
VARIANTS = {
    # The version shipped before this chapter: the Comptoir on Claude Sonnet 5.5.
    "reference": Variant("reference", comptoir_model=SONNET),
    # One change at a time, each compared with the reference.
    # The prompt: the length rule gets its means (system_v4.md, one more sentence).
    "prompt-v4": Variant("prompt-v4", comptoir_model=SONNET, prompt_version="v4"),
    # The Comptoir's model: Claude Haiku 5.5, twenty times cheaper than Sonnet 5.5 (comptoir/costs.py).
    "haiku": Variant("haiku", comptoir_model=HAIKU),
    # Chapter 18: the prompt tells the Comptoir that it is an AI, and what to answer to “are you Awa?”.
    # Compared with “haiku” (same model, prompt v3): 5 cases won, 3 lost, p = 0.73; kept.
    "prompt-v5": Variant("prompt-v5", prompt_version="v5"),
    # The shipped version: Haiku 5.5 (comptoir/config.py) since chapter 17, prompt v5 since chapter 18.
    "shipped": Variant("shipped", prompt_version="v5"),
    # Chapter 19: the Comptoir's effort at low, which the documentation advises for chat; compared with “shipped”.
    "effort-low": Variant("effort-low", prompt_version="v5", comptoir_effort="low"),
}


def fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]


def load_cases(case_set: str | None = None, ids: list[str] | None = None) -> list[dict]:
    cases = json.loads((FOLDER / "cases.json").read_text(encoding="utf-8"))
    if case_set:
        cases = [c for c in cases if c["set"] == case_set]
    if ids:
        cases = [c for c in cases if c["id"] in ids]
    return cases


def cases_fingerprint(cases: list[dict]) -> str:
    """What makes the answers: the IDs and the messages. The criteria and the references
    can be corrected, they then apply to all the series at once."""
    return fingerprint(json.dumps([[c["id"], c["message"]] for c in cases], ensure_ascii=False))


def grading_fingerprint() -> str:
    sources = [FOLDER / "code_grading.py", FOLDER.parent / "comptoir" / "notation.py"]
    return fingerprint("".join(p.read_text(encoding="utf-8") for p in sources))


def versions(variant: Variant) -> dict:
    """Everything that makes the variant, with the fingerprint of each prompt: enough to find it again."""
    return {
        "comptoir_model": variant.comptoir_model or config.COMPTOIR_MODEL,
        "comptoir_effort": variant.comptoir_effort or config.COMPTOIR_EFFORT or "model default",
        "router_model": config.ROUTER_MODEL,
        "documents_model": config.DOCUMENTS_MODEL,
        "complaints_model": f"{config.AUXILIARY_MODEL} and {config.MODEL}",
        "comptoir_prompt": load(variant.prompt_version).id,
        "documents_prompt": doc_assistant.load_prompt(variant.documents_version).id,
        "router_prompt": f"router-v1@{fingerprint(ROUTER_PROMPT)}",
    }


# --- Run ---------------------------------------------------------------------------

def run(client, variant: Variant, cases: list[dict], trials: int, max_budget: float, base,
        parallel: int = 4, progress=print) -> tuple[list[Trial], bool]:
    """Each case, `trials` times. A first trial per path (information, order, complaint, other)
    goes alone: it writes the caches the following ones will read, instead of four writes in parallel.
    Returns the trials and True if the budget stopped the series before the end."""
    tasks = [(c, n) for n in range(1, trials + 1) for c in cases]
    order = {(c["id"], n): rank for rank, (c, n) in enumerate(tasks)}
    paths, alone = set(), []
    for t in tasks:
        if t[0]["category"][0] not in paths:
            paths.add(t[0]["category"][0])
            alone.append(t)
    tasks = alone + [t for t in tasks if t not in alone]
    results, spent, lock = [], 0.0, threading.Lock()

    def one(task):
        c, n = task
        trial = run_trial(client, variant, c, n, base)
        failures = grade(c, trial)
        progress(f"  {trial.identifier:45} {'ok' if not failures else 'FAILED'} ${trial.cost_dollars:.4f} "
                 f"{trial.latency_s:>5.1f} s {'; '.join(f.reason for f in failures)[:90]}")
        return trial

    if not tasks:
        return [], False
    for task in alone:
        trial = one(task)
        results.append(trial)
        spent += trial.cost_dollars
    stopped = False
    with ThreadPoolExecutor(max_workers=parallel) as executor:
        running, rest = set(), list(tasks[len(alone):])
        while rest or running:
            while rest and len(running) < parallel:
                with lock:
                    if spent >= max_budget:
                        stopped, rest = True, []
                        break
                running.add(executor.submit(one, rest.pop(0)))
            if not running:
                break
            done, running = wait(running, return_when=FIRST_COMPLETED)
            for f in done:
                trial = f.result()
                with lock:
                    results.append(trial)
                    spent += trial.cost_dollars
    results.sort(key=lambda t: order[(t.case, t.trial)])
    return results, stopped


# --- Write and read back -------------------------------------------------------------------

def write_series(folder: Path, trials: list[Trial]) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / "trials.jsonl").open("w", encoding="utf-8") as f:
        for t in trials:
            f.write(json.dumps(t.to_dict(), ensure_ascii=False) + "\n")


def read_series(folder: Path) -> list[Trial]:
    names = {f.name for f in fields(Trial)}
    with (folder / "trials.jsonl").open(encoding="utf-8") as f:
        return [Trial(**{k: v for k, v in json.loads(l).items() if k in names}) for l in f if l.strip()]


def judgments_path(folder: Path, model: str, rubric: str = "v1") -> Path:
    """One file per judge and per version of the rubric: a corrected rubric does not mix its grades with the old ones."""
    return folder / f"judgments-{model}-{rubric}.jsonl"


def read_judgments(folder: Path, model: str, rubric: str = "v1") -> dict[str, dict]:
    path = judgments_path(folder, model, rubric)
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as f:
        return {j["trial"]: j for j in (json.loads(l) for l in f if l.strip())}


def record_in_register(entry: dict) -> None:
    REGISTER.parent.mkdir(parents=True, exist_ok=True)
    with REGISTER.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


# --- Summarize ----------------------------------------------------------------------------

def _p90(values: list[float]) -> float:
    values = sorted(values)
    return values[min(len(values) - 1, round(0.9 * (len(values) - 1)))] if values else 0.0


def summarize(trials: list[Trial], cases: list[dict], judgments: dict[str, dict] | None = None) -> dict:
    """Quality, cost and latency, together. A trial succeeds if the code finds nothing to object to,
    and, when the judge has been through, if it says “yes” to all the criteria. If the judge read only a
    sample, the summary covers only the judged trials."""
    by_id = {c["id"]: c for c in cases}
    if judgments:
        trials = [t for t in trials if t.identifier in judgments]
    grades = {t.identifier: grade(by_id[t.case], t) for t in trials}
    passed_code = {i for i, failures in grades.items() if not failures}
    summary = {
        "trials": len(trials),
        "cases": len({t.case for t in trials}),
        "code_success": len(passed_code) / len(trials) if trials else 0.0,
        "failures_by_family": dict(Counter(f.family for failures in grades.values() for f in failures)),
    }
    passed = set(passed_code)
    if judgments:
        outcomes = {i: _outcome(j) for i, j in judgments.items() if i in grades}
        summary["judged"] = len(outcomes)
        summary["judge_success"] = sum(v == "passed" for v in outcomes.values()) / len(outcomes) if outcomes else 0.0
        summary["to_review"] = sum(v == "to_review" for v in outcomes.values())
        summary["no_by_criterion"] = dict(Counter(c for j in judgments.values() if j["trial"] in grades
                                                  for c, v in j["verdicts"].items() if v == "no"))
        passed = {i for i in passed_code if outcomes.get(i) == "passed"}
        summary["success"] = len(passed) / len(trials) if trials else 0.0
        summary["judge_cost"] = round(sum(j["cost_dollars"] for j in judgments.values() if j["trial"] in grades), 4)
    by_case: dict[str, list[bool]] = {}
    for t in trials:
        by_case.setdefault(t.case, []).append(t.identifier in passed)
    summary["always_passed_cases"] = sum(all(v) for v in by_case.values())
    summary["never_passed_cases"] = sum(not any(v) for v in by_case.values())
    summary["unstable_cases"] = sorted(c for c, v in by_case.items() if any(v) and not all(v))
    summary["by_type"] = {}
    for kind in ("common", "trap", "security"):
        group = [t for t in trials if by_id[t.case]["type"] == kind]
        if group:
            summary["by_type"][kind] = sum(t.identifier in passed for t in group) / len(group)
    costs = [t.cost_dollars for t in trials]
    latencies = [t.latency_s for t in trials if not t.error]
    summary.update({
        "total_cost": round(sum(costs), 4),
        "average_cost": round(statistics.mean(costs), 5) if costs else 0.0,
        "cost_per_success": round(sum(costs) / len(passed), 5) if passed else None,
        "median_latency_s": round(statistics.median(latencies), 1) if latencies else None,
        "latency_p90_s": round(_p90(latencies), 1) if latencies else None,
        "average_calls": round(statistics.mean(len(t.calls) for t in trials), 2) if trials else 0.0,
    })
    return summary


def _outcome(judgment: dict) -> str:
    if judgment.get("error") or not judgment.get("verdicts"):
        return "to_review"
    v = judgment["verdicts"].values()
    return "failed" if "no" in v else ("passed" if all(x == "yes" for x in v) else "to_review")


def rate_per_case(trials: list[Trial], cases: list[dict], judgments: dict[str, dict] | None = None) -> dict[str, float]:
    by_id = {c["id"]: c for c in cases}
    by_case: dict[str, list[bool]] = {}
    for t in trials:
        ok = not grade(by_id[t.case], t)
        if judgments is not None:
            ok = ok and t.identifier in judgments and _outcome(judgments[t.identifier]) == "passed"
        by_case.setdefault(t.case, []).append(ok)
    return {c: sum(v) / len(v) for c, v in by_case.items()}


def show(summary: dict) -> str:
    lines = [f"{summary['trials']} trials on {summary['cases']} cases"]
    lines.append(f"  success (code): {summary['code_success']:.0%}  failures by family: {summary['failures_by_family']}")
    if "judge_success" in summary:
        lines.append(f"  success (judge): {summary['judge_success']:.0%}  to review: {summary['to_review']}  "
                     f"“no” by criterion: {summary['no_by_criterion']}")
        lines.append(f"  success (code and judge): {summary['success']:.0%}")
    lines.append(f"  cases passed at every trial: {summary['always_passed_cases']}; never: "
                 f"{summary['never_passed_cases']}; unstable: {len(summary['unstable_cases'])}")
    lines.append("  by type: " + ", ".join(f"{t} {v:.0%}" for t, v in summary["by_type"].items()))
    per = f"${summary['cost_per_success']:.4f}" if summary["cost_per_success"] else "—"
    lines.append(f"  cost: ${summary['total_cost']:.4f} in total, ${summary['average_cost']:.4f} per trial, {per} per success"
                 + (f"; judge: ${summary['judge_cost']:.4f}" if "judge_cost" in summary else ""))
    lines.append(f"  latency: median {summary['median_latency_s']} s, 90% under {summary['latency_p90_s']} s; "
                 f"{summary['average_calls']} calls per trial")
    return "\n".join(lines)


def register_entry(folder: Path, variant: Variant, case_set: str, cases: list[dict], trials: int,
                   summary: dict, stopped: bool) -> dict:
    return {
        "date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "series": folder.name,
        "variant": asdict(variant),
        "versions": versions(variant),
        "set": case_set,
        "cases_fingerprint": cases_fingerprint(cases),
        "grading_fingerprint": grading_fingerprint(),
        "trials_per_case": trials,
        "stopped_by_budget": stopped,
        "summary": summary,
    }
