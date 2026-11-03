"""Chapter 20: what Claude ran or changed, in a local log (PostToolUse hook).

One JSON line per command or per file: the date, the session, the tool, the command or the path. Never
the content of a file nor the output of a command: the log says what happened, not what was read.
It is used to reread a long or unattended session, like the Comptoir's call log
(chapter 2). It stays on the workstation (.claude/.gitignore).
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

LOG = Path(".claude") / "tool-log.jsonl"


def line(event: dict) -> dict:
    arguments = event.get("tool_input") or {}
    return {"date": datetime.now(timezone.utc).isoformat(timespec="seconds"), "session": event.get("session_id"),
            "tool": event.get("tool_name"),
            "target": (arguments.get("command") or arguments.get("file_path") or "")[:500]}


def main() -> int:
    event = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    path = Path(os.environ.get("CLAUDE_PROJECT_DIR") or ".") / LOG
    path.parent.mkdir(exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(line(event), ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
