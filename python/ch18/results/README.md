# Records of the French edition's runs

These files are the records of the trials described in the book, run on October 21, 2026 with the code, the prompts and the attacks of the French edition.

- `series/`: the four series of `ch18.attack` (69 trials): before the fixes, after the code fixes, after the second guard fix, and prompt v5. The customers' messages, Claude's answers and the tool inputs and results are kept in French. The keys, the variant and case IDs, the categories, request reasons, tool names, step names and results, and the failure reasons recorded with each trial follow the English code.
- `awa-side/`: the twelve sessions of `ch18.awa_side`; Claude's answers to Awa are in French, and `warns_awa` is the value the French counter gave (9 out of 12; reading gave 12).
- `audit-before.json`, `audit-after.json`: the two runs of `ch18.code_audit`, with the English names of the attacks and fields.
- `filter-20261021-213118.json`: the measurement of the input filter; the messages are the French ones, the IDs follow the English cases.

`python -m ch18.attack --regrade <series>` reads these series, but it grades the French answers with the English attacks: on the “before” series, it finds 9 trials held out of 15 where the book (and the French criteria) say 11, because the English criteria look for English words (“automated”, “artificial intelligence”).

Your own runs, with the English code, will add their files next to these.
