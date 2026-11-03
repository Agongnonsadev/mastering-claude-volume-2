---
name: review
description: Review of a diff or a pull request by the reviewer subagent, against the project's rules. Read-only.
disable-model-invocation: true
argument-hint: "[nothing: the branch against main | a git range | a pull request number]"
context: fork
agent: peer-review:reviewer
background: false
---

Review this change: $ARGUMENTS

- With nothing specified: the current branch against `main`, uncommitted changes included (`git diff main...HEAD`, then `git diff HEAD`).
- A range: `git diff <range>`. A pull request number: `gh pr diff <number>`.

Follow your reviewer instructions, and give your report.
