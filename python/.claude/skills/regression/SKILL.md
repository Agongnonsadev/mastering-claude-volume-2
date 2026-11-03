---
name: regression
description: Runs the chapter 17 regression on the shipped version (33 cases, paid, about $0.03, capped at $0.30) and summarizes the result.
disable-model-invocation: true
allowed-tools: Bash(python -m ch17.evaluate regression *) PowerShell(python -m ch17.evaluate regression *)
---

# The regression

Yao has just asked for it: that is the only reason to run this paid script.

1. Run `python -m ch17.evaluate regression --max-budget 0.3` from this folder.
2. Summarize: the number of cases passed out of 33, the cost, and for each failure the case, what the grading objects to, and the sentence of the answer in question.
3. Do not rerun a failing case to get green: a failure is read, replayed at most three times to count, and decided (chapter 18).
