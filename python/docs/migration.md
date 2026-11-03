# Migration procedure for the Comptoir

Chapter 21. For a model retired or replaced, a new major version of the SDK, or a new version of the API. A migration is a variant like any other (chapter 17): it is measured before it is shipped.

## 1. Knowing that you have to migrate

- Every Monday, or through the scheduled `watch.yml` job: `python -m ch21.watch`. The exit code is 1 if there is an alert.
- The watch crosses two sources: the *Model deprecations* page (published state, retirement date) and the Models API (what the key sees). On October 22, 2026, they disagreed on Claude Sonnet 4.5: the page is authoritative.
- Anthropic gives notice at least 60 days before retiring a published model, by email and in the documentation. Read the platform's release notes too.
- To know which model really serves: Console, Usage page, Export (the detail per key and per model).

## 2. Read before touching

- The migration guide of the model (for example *Claude Haiku 5.5 migration guide*) or of the API version (*Migrating to API version 2026-10-21*).
- Look in the code for each breaking change that concerns you, and write the result in a decision (`decisions/`), even when there is nothing to change.
- For a model: the price, the number of tokens of the same text, the refused parameters, the default effort, thinking.

## 3. Try it separately

- A branch, and a separate environment (`python -m venv .venv-trial`), the other dependencies pinned to the same versions (`pip freeze` as constraints): you measure only one change at a time.
- A model: a variant in `ch17/suite.py` (`/new-variant` in Claude Code), never a direct change to `comptoir/config.py`.

## 4. Measure

In order, from free to paid:

1. `python -m pytest -q`: no call.
2. A minimal call, to see what really goes out (`with_raw_response`, headers).
3. `python -m ch17.evaluate regression --max-budget 0.3`: 33 cases, about $0.03.
4. For a model: the full suite of chapter 17 (40 cases, three trials, the judge), then the verification set, once only. `python -m ch17.compare` against the series of the shipped version.
5. `python -m ch19.measure_cost --variant … --trials 1`: the cost per conversation, all steps included.
6. The image (`ch19/deployment/`) rebuilt, and a real message.

## 5. Decide, ship, keep the door open

- The written decision: what changed, what was measured, what was chosen, and how to go back.
- The image's dependencies recalculated (`uv pip compile … --generate-hashes`), the regression in the CI, then going into production (`docs/operations.md`).
- Rolling back holds as long as the old model or the old API version answers: write down until when.
