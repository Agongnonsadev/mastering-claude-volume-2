# Records of the French edition's runs

These files are the records of the measurements described in the book, run on October 22, 2026 with the code, the prompts and the conversations of the French edition.

- `costs/`: the four runs of `ch19.measure_cost` (shipped twice, `effort-low`, `no-cache`), eight conversations three times each. The keys, the variants, the conversation IDs and the categories follow the English code; the figures are those of the French run.
- `summary/`: the three runs of `ch19.evening_summary` (live with the default thinking, live without thinking, in batch). Claude's summaries are kept in French. The `facts` field is computed again by the English code (`make_day` and `facts_of_the_day`): the same figures as the French facts sent to Claude (checked when converting), with the English names of the products and the English request summaries.

Your own runs, with the English code, will add their files next to these.
