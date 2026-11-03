---
name: peer-review
description: Review of a Comptoir diff or pull request by the reviewer subagent, against the project's rules. Read-only.
disable-model-invocation: true
argument-hint: "[nothing: the branch against main | a git range | a pull request number]"
context: fork
agent: reviewer
background: false
---

Review this change: $ARGUMENTS

- With nothing specified, it is the current branch against `main`, uncommitted changes included: `git diff main...HEAD` then `git diff HEAD`.
- A range (`main...my-branch`, `HEAD~3..HEAD`): `git diff <range>`.
- A pull request number: `gh pr diff <number>`.

Follow your reviewer instructions, and give your report.
