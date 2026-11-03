# Moving to anthropic SDK 2.x and API 2026-10-21 (October 22, 2026)

Chapter 21. Délices d'Awa, Awa and Yao are fictional.

## What changed

- **On October 21, 2026**, Anthropic publishes version `2026-10-21` of the API, and Python SDK 2.0.0, which sends it by default (1.x sent `2023-06-01`). 2.1.0 follows the same day.
- **Spotted by** the Monday watch (`python -m ch21.watch`), on October 22: “anthropic SDK 1.15.0 installed, 2.1.0 available: one more major version”.
- **Breaking changes of the API** (guide *Migrating to API version 2026-10-21*): `temperature`, `top_p`, `top_k` refused; no more `document` block in an assistant message; no more `text` block with `citations` in a user message; renamed fields in the Admin API.
- **Breaking changes of the Python SDK**: `MessageParam` becomes a union by role; `betas` disappears from the non-beta Models methods; the key goes in `Authorization: Bearer` instead of `X-Api-Key`; a client holds only one credential; Apache 2.0 license.

## What the Comptoir had to change

Search in the code (comptoir/, chNN/, tests/):

| Breaking change | In the Comptoir |
|---|---|
| `temperature`, `top_p`, `top_k` | Never sent (three tests already checked it, since chapters 2, 3 and 5) |
| `document` in an assistant message | None: documents go in user messages |
| `citations` in a user message | None: only the `{"enabled": true}` setting, still allowed |
| `MessageParam(...)` | Never called: messages are dictionaries |
| `betas` on the Models methods | None; the `betas` of the agent of chapter 13 go through `client.beta` |
| `X-Api-Key` read by a proxy | No proxy; the API accepts both headers |
| Two credentials in a client | None |

Changes made: `pyproject.toml` (`anthropic>=2.1,<3`); `ch19/deployment/requirements.in` and `requirements.txt` (anthropic 2.1.0, hashes recomputed, nothing else changes); the raw HTTP example of chapter 2 sends `2026-10-21`.

## The trials, before shipping

A separate environment (`.venv-sdk2`), the other dependencies pinned to the same versions:

| Trial | SDK 1.15.0, API 2023-06-01 | SDK 2.1.0, API 2026-10-21 |
|---|---|---|
| Tests without calls | 459 passed | 465 passed (the 6 of the watch added) |
| Headers sent | — | `anthropic-version: 2026-10-21`, `Authorization: Bearer` |
| `temperature` sent | — | Refused: 400, “temperature: Extra inputs are not permitted” |
| Regression (33 cases) | 33 out of 33, $0.0336, median 6.0 s (this morning) | 33 out of 33, $0.0310, median 6.0 s |
| Eight conversations from chapter 19, one trial | $0.00118 per conversation (chapter 19, without the first trial) | $0.00116, 2 orders out of 2, no error |
| Agent of chapter 13 (Tool Runner, beta header) | — | 7 turns, $0.0094, 7 criteria out of 7 |
| Raw HTTP call of chapter 2 | — | Normal answer with `2026-10-21` |
| Docker image of chapter 19 | — | 237 MB, one chat message: right answer, $0.00026 |

## Decision

Adopted on October 22, 2026. The Comptoir moves to SDK 2.1.0 and API `2026-10-21`. 2.1.0 is only one day old: the Monday watch will follow its fixes (`2.1.x`), which the constraint `>=2.1,<3` lets through. Rollback possible: `pip install "anthropic==1.15.0"` and the old constraint, as long as the API accepts `2023-06-01`.
