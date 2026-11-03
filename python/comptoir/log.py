"""Record each call in a log: enough to find a request again and to follow the costs.

One JSON line per call. It holds the request ID (to give to Anthropic's support
in case of a problem), the model, the tokens and the cost. Never the API key,
never the content of the customers' messages.

Since chapter 8, each line can also carry what is needed to analyze failures: the
stop reason, the duration, the error code and its origin, the conversation.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

from comptoir import config
from comptoir.costs import Cost


def _write(line: dict, path: str | None) -> dict:
    file = Path(path or config.LOG)
    file.parent.mkdir(parents=True, exist_ok=True)
    with file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(line, ensure_ascii=False) + "\n")
    return line


def log_call(
    request_id: str | None,
    model: str,
    cost: Cost | None,
    path: str | None = None,
    prompt: str | None = None,
    **details,
) -> dict:
    """cost=None: the call did not go through to the end (stream cut, error). Its real cost is
    not known to the code; the Console is authoritative.

    details (chapter 8): stop_reason, duration_ms, error, origin, customer… None values
    are not written.
    """
    line = {
        "date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "request": request_id,
        "model": model,
        "prompt": prompt,  # version and fingerprint of the system prompt (chapter 5)
        "input_tokens": cost.input if cost else None,
        "cache_write_tokens": cost.cache_write if cost else None,
        "cache_read_tokens": cost.cache_read if cost else None,
        "output_tokens": cost.output if cost else None,
        "thinking_tokens": cost.thinking if cost else None,
        "cost_dollars": round(cost.dollars, 6) if cost else None,
    }
    if cost and cost.searches:
        line["web_searches"] = cost.searches  # chapter 10
    if cost is None:
        line["interrupted"] = True
    line.update({key: value for key, value in details.items() if value is not None})
    return _write(line, path)


def log_event(event: str, path: str | None = None, **details) -> dict:
    """An event without a call to the API: a message refused by the budget, for example."""
    line = {"date": datetime.now(timezone.utc).isoformat(timespec="seconds"), "event": event}
    line.update({key: value for key, value in details.items() if value is not None})
    return _write(line, path)
