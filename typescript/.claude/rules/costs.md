---
paths:
  - "comptoir/costs.ts"
  - "comptoir/budget.ts"
  - "ch*/measure*.ts"
---

# Costs and the budget

- The prices in `comptoir/costs.ts` come from Anthropic's Pricing page, with the date they were read in a comment, and stay the same as those of `../python/comptoir/costs.py`. The `file_guard` hook asks Yao to confirm each change.
- A cost is calculated from the tokens of the response (`usage`), never from an estimate by the model.
- The budget counts the whole message, all steps included (`comptoir/service.ts`, chapter 19).
- A measurement script has a free `--estimate` and a `--max-budget`; it writes its results as it goes.
