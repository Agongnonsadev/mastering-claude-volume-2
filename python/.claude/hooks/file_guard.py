"""Chapter 20: what Claude Code does not change without Yao seeing it (PreToolUse hook, Edit and Write).

CLAUDE.md asks for these rules; this hook enforces them, every time, without Claude having to remember them:
- a prompt version is not changed: the next one is written, and evaluated (chapters 5 and 17);
- a test never calls the API: no real client in tests/, except toward a fake local server;
- the prices of comptoir/costs.py come from Anthropic's Pricing page: Yao confirms each change.

Input: the event as JSON on standard input. Output: nothing (no objection), or a “deny” or
“ask” decision with its reason, which Claude reads.
"""

import json
import os
import re
import sys
from pathlib import Path

VERSIONED_PROMPT = re.compile(r"^comptoir/prompts/[a-z_]+_v\d+\.md$")
CLIENT = re.compile(r"\b(?:Async)?Anthropic\(|\bmake_client\(")
LOCAL_SERVER = re.compile(r"base_url\s*=\s*f?[\"']https?://(?:127\.0\.0\.1|localhost)")


def relative(path: str, root: Path) -> str:
    """The file's path relative to the project, with forward slashes, under Windows too."""
    if not path:
        return ""
    p = Path(path)
    try:
        p = p.resolve().relative_to(root.resolve())
    except (ValueError, OSError):
        pass
    return p.as_posix()


def written_texts(arguments: dict) -> list[str]:
    """What the tool is going to write: the content of Write, the new text of Edit (or of each grouped Edit)."""
    texts = [arguments.get("content") or "", arguments.get("new_string") or ""]
    texts += [e.get("new_string") or "" for e in arguments.get("edits") or []]
    return [t for t in texts if t]


def calls_the_api(text: str) -> bool:
    """A real client, or make_client(): forbidden in a test. A client toward 127.0.0.1 stays allowed
    (the fake server of chapter 6)."""
    for found in CLIENT.finditer(text):
        if found.group().startswith("make_client"):
            return True
        if not LOCAL_SERVER.search(text[found.end():found.end() + 400]):
            return True
    return False


def examine(event: dict, root: Path) -> tuple[str, str] | None:
    arguments = event.get("tool_input") or {}
    file = relative(arguments.get("file_path", ""), root)
    if VERSIONED_PROMPT.match(file) and (root / file).exists():
        version = int(re.search(r"_v(\d+)\.md$", file).group(1))
        next_version = re.sub(r"_v\d+\.md$", f"_v{version + 1}.md", file)
        return "deny", (f"{file} is a published version: evaluation series refer to it by its fingerprint. "
                        f"Write the next version ({next_version}), then evaluate it as a variant (chapter 17).")
    if file.startswith("tests/") and any(calls_the_api(t) for t in written_texts(arguments)):
        return "deny", ("A test never calls the API: each call is paid. Use a fake client "
                        "(see FakeClient in the existing tests), or a fake server on 127.0.0.1.")
    if file == "comptoir/costs.py":
        return "ask", ("The prices in comptoir/costs.py come from Anthropic's Pricing page. "
                       "Does the change have a dated source? Yao confirms it himself.")
    return None


def main() -> int:
    # Claude Code writes and reads UTF-8; the Windows console does not: Python is not left to guess.
    event = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    sys.stdout.reconfigure(encoding="utf-8")
    root = Path(os.environ.get("CLAUDE_PROJECT_DIR") or event.get("cwd") or ".")
    result = examine(event, root)
    if result:
        decision, reason = result
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": decision,
                                                 "permissionDecisionReason": reason}}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
