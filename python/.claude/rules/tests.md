---
paths:
  - "tests/**"
---

# The Comptoir's tests

- No test calls the API: a fake client (`FakeClient`) or a fake server on 127.0.0.1. The `file_guard` hook refuses a real client in `tests/`.
- One test file per module or per chapter (`test_chNN.py`), test names that state the rule (`test_a_duplicate_from_meta_is_handled_only_once`).
- One rule per test; a failing test must say which rule gave way.
- The log points to `tmp_path` (fixture), never to `log/calls.jsonl`.
- An unstable test is a defect to find, not a test to rerun (chapter 19).
