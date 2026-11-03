#!/bin/sh
# Chapter 20: runs one of the project's Python hooks with the project's Python (.venv), otherwise the system's.
# Claude Code runs hooks through sh on macOS and Linux, through Git Bash on Windows.
root="${CLAUDE_PROJECT_DIR:-.}"
for py in "$root/.venv/bin/python" "$root/.venv/Scripts/python.exe" python3 python; do
  if command -v "$py" >/dev/null 2>&1; then
    exec "$py" "$root/.claude/hooks/$1.py"
  fi
done
echo "Hook $1: no Python interpreter found." >&2
exit 1
