---
paths:
  - "tests/**"
---

# The Comptoir's tests

- No test calls the API: a fake client (`FakeClient`, in `tests/fake_clients.ts`) or a fake server on 127.0.0.1. The `file_guard` hook refuses a real client in `tests/`.
- One test file per module or per chapter (`chNN.test.ts`), test names that state the rule (“a duplicate from Meta is handled only once”).
- One rule per test; a failing test must say which rule gave way.
- The log points to a temporary folder (`temporaryLog()`), never to `log/calls.jsonl`.
- The comparisons with the Python version run its Python (`../python/.venv`) with a temporary log; without it, they are skipped.
- An unstable test is a defect to find, not a test to rerun (chapter 19).
