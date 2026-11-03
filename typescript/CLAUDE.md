# Awa's Comptoir, in TypeScript

Order-taking and customer service assistant for Délices d'Awa (fictional business), in TypeScript on Node 22.13 or later, with the `@anthropic-ai/sdk` SDK 1.x (API `2026-10-21`). Companion code for Volume 2 of “Mastering Claude” (Botlyx Academy): the equivalent of the Python version (`../python/`), which remains the book's reference.

## Commands
- Install: `npm ci`
- Test: `npm test` (no test calls the API; the tests use a fake client). Check the types: `npm run typecheck`
- Run a chapter script: `npx tsx ch02/comptoir_cli.ts "question"` from this folder

## Layout
- `comptoir/`: shared code (configuration, costs, log, grading), the same modules as in Python
- `chNN/`: scripts for chapter NN, with the same names as in Python
- `tests/`: one test file per module or per chapter; `fake_clients.ts` for the fake clients
- The data shared by the two versions (catalog, prompts, Awa's knowledge base, evaluation cases) stay in `../python/`: this version reads them there. A single copy.

## Rules
- Never read, display or write the API key. It lives in `ANTHROPIC_API_KEY`, never in the code or in a file.
- Never run a script that calls the API unless I ask: every call costs money.
- The model and the effort come from `comptoir/config.ts`, never from a hard-coded string in the Comptoir's code.
- Exact amounts (prices, totals, fees) are calculated by the code, never by the model.
- The prices in `comptoir/costs.ts` come from Anthropic's Pricing page: do not change them without a dated source.
- What must give the same result as the Python version goes through `comptoir/python.ts` (repr, json.dumps, sum, mean), `comptoir/rounding.ts` (round) and `comptoir/random.ts` (random.Random).
- Every new function has its tests; a test must never call the API.
- Do not touch files outside the scope of the requested task.
- Texts for Awa's customers: in English, polite and formal.

## Project tools (chapter 20)
- Before a commit: `/verify` (tests, types and review of the diff, free). In-depth review: `/peer-review`.
- Per-folder rules: `.claude/rules/` (tests, prompts, costs), loaded when you touch those files.
- The hooks of `.claude/settings.json` block a secret in a commit, a real client in `tests/`, the modification of a published prompt version, rerun the tests at the end of a turn, and record each command in `.claude/tool-log.jsonl`: do not try to get around them, tell Yao what is blocking. They are TypeScript programs without dependencies, which Node runs alone.
