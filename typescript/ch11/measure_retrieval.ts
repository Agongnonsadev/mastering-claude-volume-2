// Chapter 11: does the retrieval find the right chunk? Recall at 1, 3 and 5, without a call to Claude.
//
// For each question whose answer is in the documents, we check whether one of the expected chunks is in
// the first k results. Indexes compared: BM25 on the raw chunks, BM25 on the contextualized chunks (if the
// contexts have been computed), and, if VOYAGE_API_KEY is set, Voyage AI's embeddings (paid) and hybrid
// search (rank fusion).
//
// Run, from the typescript/ folder:  npx tsx ch11/measure_retrieval.ts

import { loadKnowledge } from "../comptoir/knowledge.ts";
import { BM25Index, type Ranking, VectorIndex, fuse, recall, voyageEmbedder } from "../comptoir/retrieval.ts";
import { round } from "../comptoir/rounding.ts";
import { contextualizedBase, loadQuestions } from "./shared.ts";

type Searcher = (question: string, k: number) => Ranking | Promise<Ranking>;

const cases = loadQuestions().filter((c) => !c.absent);
const bm25 = new BM25Index(loadKnowledge());
const searchers = new Map<string, Searcher>([["BM25", (q, k) => bm25.search(q, k)]]);
const contextualized = contextualizedBase();
if (contextualized) {
  const index = new BM25Index(contextualized);
  searchers.set("contextual BM25", (q, k) => index.search(q, k));
}
if (process.env.VOYAGE_API_KEY) {
  const vectors = await VectorIndex.create(contextualized ?? loadKnowledge(), voyageEmbedder());
  const lexical = new BM25Index(contextualized ?? loadKnowledge());
  searchers.set("embeddings", (q, k) => vectors.search(q, k));
  searchers.set("hybrid", async (q, k) => fuse([lexical.search(q, 20), await vectors.search(q, 20)], { keep: k }));
}

/** 0.75 -> “75%”, like Python's .0% format. */
const percent = (t: number): string => `${round(t * 100)}%`;

console.log(`${cases.length} questions whose answer is in the documents\n`);
console.log(`${"index".padEnd(18)} ${"recall@1".padStart(9)} ${"recall@3".padStart(9)} ${"recall@5".padStart(9)}`);
for (const [name, search] of searchers) {
  const rates: number[] = [];
  for (const k of [1, 3, 5]) {
    let found = 0;
    for (const c of cases) if (recall(await search(c.question, k), c.sources)) found++;
    rates.push(found / cases.length);
  }
  console.log(`${name.padEnd(18)} ` + rates.map((r) => percent(r).padStart(9)).join(" "));
  const missed: string[] = [];
  for (const c of cases) if (!recall(await search(c.question, 5), c.sources)) missed.push(c.id);
  if (missed.length) console.log(`${"".padEnd(18)} outside the top 5: ${missed.join(", ")}`);
}
