# Records of the French edition's runs

These files are the records of the series described in the book, run on October 21 and 22, 2026 with the code, the prompts and the cases of the French edition (13 series, 888 trials, 1,020 judgments).

- **Kept in French, as measured:** the customers' messages, the Comptoir's answers and summaries, the tool inputs and results, the judge's findings, Awa's remarks, the reasons written in the register, the references shown to Awa, and the raw output of Claude Opus 5.5 (`candidates.raw.txt`). Awa graded French answers.
- **Following the English code:** the file and folder names, the keys, the series, variant and case IDs, the categories, statuses, request reasons, tool names, step names and step results, the criteria, verdicts and outcomes. The “What the system did” of each card in `sample.json`, `sample-haiku.json` and `to_grade.html` is rebuilt by the English `ch17.judge.actions`, from the converted trials.
- **Fingerprints:** the register keeps those of the French run (`system-v3@99a31a70`, `cases_fingerprint`, `grading_fingerprint`). The English prompts, cases and grading have their own; a new series will not compare with these ones through `ch17.compare`, which requires the same cases' fingerprint.

`python -m ch17.sample calibrate` reads these files and gives the agreement of the book (step 8). `python -m ch17.evaluate summarize <series>` also reads them, but it grades the French answers with the English cases: its figures differ from the register's.

Your own runs, with the English code, will add their series next to these.
