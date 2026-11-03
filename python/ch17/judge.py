"""Grading by Claude, with a rubric (chapter 17).

The judge reads what the code cannot judge: an accurate or invented statement, a promise
phrased otherwise, an answer beside the point, the tone. It works in its own context: it sees
neither the Comptoir's prompt nor its thinking, only Awa's documents, the message, the answer,
the system's actions and the reference. It writes its finding before its verdict (the schema's
order is respected, and a verdict given before the finding is wrong more often, chapter 12), and it
is allowed “unknown” rather than inventing.

A judge is checked before it is used: ch17/calibration.py compares its verdicts with human grades.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path

from comptoir.costs import cost
from comptoir.knowledge import load_knowledge
from comptoir.log import log_call
from comptoir.prompt import SystemPrompt, load_data, render_catalog, render_terms

FOLDER = Path(__file__).parent
CRITERIA = ("accurate", "no_promise", "answers", "tone")
RUBRIC = "v2"  # v1: without the tool results; v2: with them (see actions)
VERDICTS = ("yes", "no", "unknown")
MAX_TOKENS = 3000

SCHEMA = {
    "type": "object",
    "properties": {
        c: {
            "type": "object",
            "properties": {"finding": {"type": "string"}, "verdict": {"type": "string", "enum": list(VERDICTS)}},
            "required": ["finding", "verdict"],
            "additionalProperties": False,
        }
        for c in CRITERIA
    },
    "required": list(CRITERIA),
    "additionalProperties": False,
}


def load_rubric(version: str = RUBRIC) -> SystemPrompt:
    text = (FOLDER / "rubrics" / f"judge_{version}.md").read_text(encoding="utf-8").strip()
    return SystemPrompt(text, f"judge-{version}")


def documents() -> str:
    """The same facts as the Comptoir's: catalog, terms and Awa's base."""
    data = load_data()
    base = "\n\n".join(f"## {c.title}\n{c.text}" for c in load_knowledge())
    return (f"<documents>\n<catalog>\n{render_catalog(data)}\n</catalog>\n<terms>\n"
            f"{render_terms(data)}\n</terms>\n{base}\n</documents>")


def tools_and_results(trial) -> list[str]:
    """Each tool called, with what it answered: the result of a call arrives with the next call."""
    lines = []
    for rank, call in enumerate(trial.calls):
        requested = [b for b in call["returned"] if b["type"] == "tool_use"]
        received = trial.calls[rank + 1]["received"] if rank + 1 < len(trial.calls) else []
        for i, block in enumerate(requested):
            result = received[i] if i < len(received) else None
            answer = ("(no result)" if result is None
                      else ("ERROR: " if result["error"] else "") + result["content"][:220])
            lines.append(f"- {block['name']} {json.dumps(block['input'], ensure_ascii=False)[:160]} → {answer}")
    return lines


def actions(trial) -> str:
    """What the system did, read in the shop and in the transcript: the judge checks the text
    against the facts. Added after the first grading: without the tool results, the judge took
    for invented a stock that the Comptoir had indeed checked."""
    pending = [s for s in trial.summaries if s["status"] == "pending"]
    lines = [f"summary prepared: {'yes, total ' + str(pending[-1]['total']) + ' FCFA' if pending else 'no'}",
             f"requests passed on to Awa: {', '.join(trial.requests) if trial.requests else 'none'}",
             f"orders created: {trial.orders}"]
    tools = tools_and_results(trial)
    lines.append("tools called and their results:" + ("\n" + "\n".join(tools) if tools else " none"))
    return "\n".join(lines)


def request(case: dict, trial, model: str, rubric: SystemPrompt | None = None) -> dict:
    rubric = rubric or load_rubric()
    summary = trial.text[len(trial.claude_text):].strip() or "none"
    to_grade = (f"<customer_message>\n{case['message']}\n</customer_message>\n"
                f"<comptoir_answer>\n{trial.claude_text}\n</comptoir_answer>\n"
                f"<official_summary>\n{summary}\n</official_summary>\n"
                f"<system_actions>\n{actions(trial)}\n</system_actions>\n"
                f"<reference>\n{case['reference']}\n</reference>")
    return {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": rubric.text,
        "messages": [{"role": "user", "content": [
            # The documents do not change from one judgment to the next: they are read from the cache.
            {"type": "text", "text": documents(), "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": to_grade},
        ]}],
        "output_config": {"format": {"type": "json_schema", "schema": SCHEMA}},
    }


@dataclass
class Judgment:
    trial: str                     # the ID of the trial judged
    model: str
    rubric: str
    verdicts: dict[str, str] = field(default_factory=dict)
    findings: dict[str, str] = field(default_factory=dict)
    cost_dollars: float = 0.0
    error: str | None = None

    @property
    def outcome(self) -> str:
        """“passed” if everything is yes, “failed” at the first no, otherwise “to_review”."""
        if self.error or not self.verdicts:
            return "to_review"
        if "no" in self.verdicts.values():
            return "failed"
        return "passed" if all(v == "yes" for v in self.verdicts.values()) else "to_review"


def judge(client, case: dict, trial, model: str, rubric: SystemPrompt | None = None) -> Judgment:
    rubric = rubric or load_rubric()
    params = request(case, trial, model, rubric)
    message = client.messages.create(**params)
    price = cost(model, message.usage)
    log_call(message._request_id, model, price, prompt=rubric.id, stop_reason=message.stop_reason)
    judgment = Judgment(trial.identifier, model, rubric.id, cost_dollars=round(price.dollars, 6))
    if message.stop_reason != "end_turn":
        judgment.error = f"judgment stopped by {message.stop_reason}"
        return judgment
    data = json.loads("".join(b.text for b in message.content if b.type == "text"))
    judgment.verdicts = {c: data[c]["verdict"] for c in CRITERIA}
    judgment.findings = {c: data[c]["finding"] for c in CRITERIA}
    return judgment
