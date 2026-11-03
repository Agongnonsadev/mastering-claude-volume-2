---
paths:
  - "comptoir/costs.py"
  - "comptoir/budget.py"
  - "ch*/measure*.py"
---

# Costs and the budget

- The prices in `comptoir/costs.py` come from Anthropic's Pricing page, with the date they were read in a comment. The `file_guard` hook asks Yao to confirm each change.
- A cost is calculated from the tokens of the response (`usage`), never from an estimate by the model.
- The budget counts the whole message, all steps included (`comptoir/service.py`, chapter 19).
- A measurement script has a free `--estimate` and a `--max-budget`; it writes its results as it goes.
