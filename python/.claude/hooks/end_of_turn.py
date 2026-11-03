"""Chapter 20: Claude does not hand back on red tests (Stop hook).

When Claude has finished answering, the hook looks at whether Python code has changed since the last
green run. If so, the test suite runs (without a paid call: a fake client everywhere). Red: the hook
sends back the end of the report with “decision: block”, and Claude continues to fix it, or explains why
the failure is expected. Green: the fingerprint of the changes is recorded, so as not to rerun the same suite.

Claude Code itself stops the loop after eight relaunches in a row (hooks documentation).
COMPTOIR_HOOK_TESTS replaces the test command (for the hook's tests).
"""

import hashlib
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

STATE = Path(".claude") / ".last-green"   # ignored by Git (.claude/.gitignore)


def git(root: Path, *arguments: str) -> str:
    return subprocess.run(["git", *arguments], cwd=root, capture_output=True, text=True, encoding="utf-8",
                          errors="replace").stdout


def fingerprint(root: Path) -> str:
    """The state of the Python code compared with the last commit: changed, added or new. Empty if nothing changed."""
    diff = git(root, "diff", "HEAD", "--no-color", "--", "*.py")
    new = git(root, "ls-files", "--others", "--exclude-standard", "--", "*.py").split()
    if not diff and not new:
        return ""
    h = hashlib.sha256(diff.encode("utf-8"))
    for name in sorted(new):
        h.update(name.encode("utf-8"))
        h.update((root / name).read_bytes())
    return h.hexdigest()


def main() -> int:
    json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    sys.stdout.reconfigure(encoding="utf-8")
    root = Path(os.environ.get("CLAUDE_PROJECT_DIR") or ".")
    current = fingerprint(root)
    state = root / STATE
    if not current or (state.exists() and state.read_text(encoding="utf-8") == current):
        return 0
    command = shlex.split(os.environ.get("COMPTOIR_HOOK_TESTS", "")) or [
        sys.executable, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider"]
    result = subprocess.run(command, cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode == 0:
        state.parent.mkdir(exist_ok=True)
        state.write_text(current, encoding="utf-8")       # the fingerprint of the changes that went green
        return 0
    tail = "\n".join((result.stdout + result.stderr).strip().splitlines()[-25:])
    print(json.dumps({"decision": "block", "reason": (
        "The test suite fails after your changes. Fix it before handing back, or explain to Yao "
        "why the failure is expected. End of the report:\n" + tail)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
