# Awa's Comptoir

Order-taking and customer service assistant for Délices d'Awa (fictional business), in Python 3.10+ with the `anthropic` SDK 2.x (API `2026-10-21`). Companion code for Volume 2 of “Mastering Claude” (Botlyx Academy).

## Commands
- Install: `pip install -e ".[tests]"` in a `.venv` virtual environment
- Test: `python -m pytest` (no test calls the API; the tests use a fake client)
- Run a chapter script: `python -m ch02.comptoir_cli "question"` from this folder

## Layout
- `comptoir/`: shared code (configuration, costs, log, grading)
- `chNN/`: scripts for chapter NN
- `tests/`: one test file per module or per chapter

## Rules
- Never read, display or write the API key. It lives in `ANTHROPIC_API_KEY`, never in the code or in a file.
- Never run a script that calls the API unless I ask: every call costs money.
- The model and the effort come from `comptoir/config.py`, never from a hard-coded string in the Comptoir's code.
- Exact amounts (prices, totals, fees) are calculated by the code, never by the model.
- The prices in `comptoir/costs.py` come from Anthropic's Pricing page: do not change them without a dated source.
- Every new function has its tests; a test must never call the API.
- Do not touch files outside the scope of the requested task.
- Texts for Awa's customers: in English, polite and formal.

## Project tools (chapter 20)
- Before a commit: `/verify` (tests and review of the diff, free). In-depth review: `/peer-review`.
- Per-folder rules: `.claude/rules/` (tests, prompts, costs), loaded when you touch those files.
- The hooks of `.claude/settings.json` block a secret in a commit, a real client in `tests/`, the modification of a published prompt version, rerun the tests at the end of a turn, and record each command in `.claude/tool-log.jsonl`: do not try to get around them, tell Yao what is blocking.
