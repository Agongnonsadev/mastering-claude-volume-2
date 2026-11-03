# Records of the French edition's runs

These files are the records of the trials described in the book, run on October 20, 2026 with the code, the prompts, the documents and the questions of the French edition.

- `trials*.csv` are kept as they were measured: the answers of Claude, the grading reasons and the remarks are in French. Only the column names, the case IDs, the modes and the `kb://` IDs of the cited sources follow the English code. The case `card-french` was, in the French run, the case `carte-anglais`: a question in English, on documents in French.
- `contexts.json` holds the 41 context sentences written by Claude Haiku 5.5 for the French documents, translated into English and keyed by the IDs of the English base, so that `ch11.measure_retrieval` can read them.

Your own runs, with the English code, will overwrite these files.
