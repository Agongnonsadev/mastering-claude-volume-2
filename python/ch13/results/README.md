# Records of the French edition's runs

These files are the records of the sessions described in the book, run on October 20, 2026 with the code, the prompts and the data of the French edition.

- `agent.csv` and `sessions.jsonl` hold the nine sessions of the evaluation (three per setting). The orders' justifications and alerts, and the agents' summaries, are kept as Claude wrote them: in French. The column names, the settings, the items, the units, the statuses, the tool names and the lines of the traces follow the English code.
- `orders.json` holds the two orders of the memory test: the order rejected by Awa, then the one proposed with her feedback. `python -m ch13.approve_order --orders ch13/results/orders.json --list` reads it.
- `memory/memories/` holds the agent's memory after these two sessions. `follow-up.md` was written by Claude, in French. `awa-feedback.md` was written by the code: its heading and its line format follow the English code, and Awa's note stays in French.

The verdicts in `agent.csv` and `sessions.jsonl` are those of the French run. Recomputing them with `ch13.criteria` on these records gives the same result, except for `pineapple_alert`: the English criterion looks for “pineapple” in the alerts, and these alerts say “ananas”.

Your own runs, with the English code, will overwrite these files.
