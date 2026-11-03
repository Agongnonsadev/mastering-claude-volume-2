# Decision — The Comptoir's model (October 20, 2026)

- **Choice:** Claude Sonnet 5.5 (`claude-sonnet-5-5`), effort `high` (its default effort). `COMPTOIR_EFFORT` can stay empty.
- **Why:** 45 successes out of 45 and a clean review, for $0.0026 per success; median latency of 2.2 s.
- **Ruled out:**
  - Opus 5.5: 1.6 to 1.8 times more expensive, nothing more passed on these cases.
  - Sonnet 5.5 at `low`: the language instruction ignored three times out of three, for 22% savings per success.
  - Haiku 5.5, for now: liberties with the information (“only in Cotonou”, an order number that does not exist). More than twenty times cheaper: the candidate for simple questions, behind a router (chapter 12).
- **Not measured:** the `medium` effort, suggested by the documentation for a chat with Sonnet 5.5.
- **Budget:** $19 a month for 7,200 calls at the measured cost, but $57.60 with the 3,000 input tokens planned in chapter 1. Caching (chapter 11) and the router (chapter 12) are needed to stay within the $26.
- **To reassess:** at each new model, at each major change to the prompt, and at the latest three months after going live, with the full evaluation of chapter 17.

Measurement: `python -m ch03.compare_models --repetitions 3 --max-budget 2`, 15 cases, prompt version 0, 270 calls, $0.6247. Details: `ch03/results/trials.csv`.

## Revision of October 21, 2026 — the evaluation of chapter 17

- **Choice:** the routed Comptoir (orders and other requests) moves to **Claude Haiku 5.5** (`COMPTOIR_COMPTOIR_MODEL`, default `claude-haiku-5-5`). Sonnet 5.5 remains the model for drafting complaints (`COMPTOIR_MODEL`), which has not been evaluated with another model. The router and the document assistant were already on Haiku 5.5.
- **Why:** on the 40 improvement cases, three trials: 92% (code), 90% (code and judge) against 90% and 85% for Sonnet 5.5, six cases won and five lost (chance); on the 20 verification cases: 80% and 78% against 68% and 62%, eight cases won and two lost (p = 0.11). Awa accepts its answers as she accepts those of Sonnet 5.5 (ten answers reviewed blind). Average cost of a trial: $0.0009 against $0.0056. Budget recalculated with the mix of chapter 12: about $5 a month against about $27.
- **What has changed since chapter 3:** the “liberties with the information” of Haiku 5.5 are still there (three times out of three, it passes on a request for labels for 80 bottles without recalling the threshold of 100), but Sonnet 5.5 has its own failures (four-sentence answers), and the code catches both.
- **Not yet ready for all customers:** 78% on the verification set, for a threshold of 90%. To fix, one thing at a time: the router (a guarantee classified as a complaint), the document assistant (transfers announced without a tool), the word check of complaints (a negation taken for a promise), and the length rule (Awa's decision on polite phrases).
- **To reassess:** at each change, with `python -m ch17.evaluate regression`; before each delivery, with the full suite and a new verification set.

Measurement: `python -m ch17.evaluate` (series and register in `ch17/results/`), 513 trials, $2.59 with the judges.
