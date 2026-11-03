#!/bin/sh
# Chapter 20: runs one of the project's hooks, written in TypeScript, with Node alone: Node 22 strips the types
# (--experimental-strip-types, on by default since Node 22.18); the hook imports nothing from the project.
# Claude Code runs hooks through sh on macOS and Linux, through Git Bash on Windows.
root="${CLAUDE_PROJECT_DIR:-.}"
if command -v node >/dev/null 2>&1; then
  exec node --experimental-strip-types --disable-warning=ExperimentalWarning "$root/.claude/hooks/$1.ts"
fi
echo "Hook $1: Node cannot be found." >&2
exit 1
