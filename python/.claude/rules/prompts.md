---
paths:
  - "comptoir/prompts/**"
  - "comptoir/prompt.py"
---

# The Comptoir's prompts

- A published version is never modified: the evaluation series of chapter 17 refer to it by its fingerprint. You write the next one (`system_v6.md`), and the `file_guard` hook refuses the change of an existing version.
- A new version is a variant: it goes into `ch17/suite.py` (`VARIANTS`), you estimate it (`python -m ch17.evaluate estimate`), and Yao runs the paid series himself.
- Amounts, codes and totals come from the code, never from the prompt.
- Texts for Awa's customers: in English, in French for a customer who writes in French, and the mention of the AI stays.
