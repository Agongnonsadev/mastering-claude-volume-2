---
name: verify
description: Checks the Comptoir before a commit or a pull request. Runs the test suite without paid calls and the type check, reviews the diff for secrets and the project's rules, and gives a short verdict. Use before each commit, or when asked whether the code is ready.
allowed-tools: Bash(npm test) Bash(npm run typecheck) Bash(git diff *) Bash(git status *) PowerShell(npm test) PowerShell(npm run typecheck) PowerShell(git diff *) PowerShell(git status *)
---

# Checking the Comptoir

Chapter 20. The name `verify` matters: when a project Skill has this name, Claude Code runs it before each commit.

## The changes

!`git status --short`

## To do, in order

Run each command alone, without a pipe or a chain (`|`, `;`, `&&`): only simple commands are allowed in advance.

1. Run `npm test` from this folder. No test calls the API: it is free.
2. Run `npm run typecheck`.
3. Read `git diff HEAD` and check, file by file:
   - no key, no token, no `.env` (the `secret_guard` hook will block the commit anyway: say so beforehand);
   - no published prompt version modified (`../python/comptoir/prompts/*_vN.md`);
   - each new function has its test;
   - no amount written by the model: the totals come from the code;
   - texts for customers are in English, in French for a customer who writes in French.
4. Run no `npx tsx chNN/…` script: many call the API, and each call is paid.

## Your answer

Three lines at most: the tests and the types (number passed, or the first failure), what the review found, and the verdict “ready” or “not ready”.
