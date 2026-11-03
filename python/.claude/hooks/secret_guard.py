"""Chapter 20: no secret leaves in a commit (PreToolUse hook, on “git commit”).

Before Claude runs a commit, the hook reads what is going to be recorded: the staged changes, and
also the modified or new files when the command adds them itself (git add … && git commit,
git commit -a). An Anthropic API key, a Meta token, a private key, a secret written in plain text
(MY_API_KEY=…, TOKEN = "…"), or a .env file: the commit is blocked (code 2), and Claude reads why.
Demonstration values (“replace-me”, “…-test”, “fake”) get through.

The same file serves in the secret-guard plugin (tome-2-en/code/claude-tools): it knows no name
specific to the Comptoir. A key that has left the machine is changed, even if the commit is cancelled: it says so.
"""

import json
import re
import subprocess
import sys

# Names in capitals: environment variables and constants. The secret="…" argument of a test is not one.
SECRET_NAME = r"\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|_SALT)[A-Z0-9_]*"
DUMMY = r"(?![^\"'\s]*(?:replace|example|test|fake|dummy|local|trial|xxxx))"
PATTERNS = [
    ("an Anthropic API key", re.compile(r"sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,}")),
    ("a Meta access token", re.compile(r"\bEAA[A-Za-z0-9]{60,}")),
    ("a private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    # NAME=value, alone on its line (.env file, shell), or NAME = "value" (code); not NAME = os.environ…
    ("a secret written in plain text", re.compile(
        rf"^\s*(?:export\s+)?{SECRET_NAME}\s*=\s*{DUMMY}[^\s\"'$<{{#]{{8,}}\s*$"
        rf"|\b{SECRET_NAME}\s*[=:]\s*[\"']{DUMMY}[^\"'\s$<{{]{{8,}}[\"']")),
]
# .env.example contains only dummy values: allowed. The other .env files, no.
FORBIDDEN_FILE = re.compile(r"(?:^|/)\.env(?:\.(?!example$)[^/]+)?$|\.pem$|(?:^|/)\.env\.txt$")
ADDS_ITSELF = re.compile(r"\bgit\s+add\b|\bgit\s+commit\b[^&|;]*\s(?:-[a-zA-Z]*a[a-zA-Z]*|--all)\b")


def git(cwd: str, *arguments: str) -> str:
    # No check of the return code: “git diff --no-index” returns 1 when it finds a difference.
    return subprocess.run(["git", *arguments], cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace").stdout


def added_lines(diff: str):
    """(file, line number, text) for each added line of a unified diff without context."""
    file, number = "", 0
    for line in diff.splitlines():
        if line.startswith("+++ "):
            file = line[6:] if line.startswith("+++ b/") else ""
        elif line.startswith("@@"):
            number = int(re.search(r"\+(\d+)", line).group(1))
        elif line.startswith("+") and file:
            yield file, number, line[1:]
            number += 1


def mask(secret: str) -> str:
    return secret[:6] + "…" if len(secret) > 6 else "…"


def find(cwd: str, command: str) -> list[str]:
    everything = bool(ADDS_ITSELF.search(command))
    diffs = [git(cwd, "diff", "--cached", "-U0", "--no-color")]
    names = git(cwd, "diff", "--cached", "--name-only").splitlines()
    if everything:
        diffs.append(git(cwd, "diff", "-U0", "--no-color"))
        names += git(cwd, "diff", "--name-only").splitlines()
        new = git(cwd, "ls-files", "--others", "--exclude-standard").splitlines()
        names += new
        for name in new:
            diffs.append(git(cwd, "diff", "--no-index", "-U0", "--no-color", "/dev/null", name))
    findings = [f"{name}: a secrets file never goes into Git" for name in dict.fromkeys(names)
                if FORBIDDEN_FILE.search(name)]
    for diff in diffs:
        for file, number, text in added_lines(diff):
            for kind, pattern in PATTERNS:
                if found := pattern.search(text):
                    findings.append(f"{file}:{number}: {kind} ({mask(found.group().strip())})")
    for kind, pattern in PATTERNS[:3]:  # the commit message, too
        if found := pattern.search(command):
            findings.append(f"the commit message: {kind} ({mask(found.group())})")
    return findings


def main() -> int:
    event = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    sys.stderr.reconfigure(encoding="utf-8")
    command = (event.get("tool_input") or {}).get("command", "")
    if not re.search(r"\bgit\s+commit\b", command):
        return 0
    findings = find(event.get("cwd") or ".", command)
    if not findings:
        return 0
    print("Commit blocked by the secret guard:\n- " + "\n- ".join(findings) +
          "\nRemove these lines or these files from the commit (git restore --staged <file>), put the secret in the "
          "environment, and warn the person in charge: a secret that may have left the machine is changed.",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
