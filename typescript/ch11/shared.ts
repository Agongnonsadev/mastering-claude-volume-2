// What the scripts of chapter 11 share: the base, the contexts already computed, the retrieval.
//
// The 20 questions are those of the Python version (python/ch11/questions.json). The context sentences
// too, as long as ch11/contextualize.ts has not written its own in ch11/results/contexts.json.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type DocCase, makeDocCase } from "../comptoir/doc_assistant.ts";
import { type Chunk, loadKnowledge, withContexts } from "../comptoir/knowledge.ts";
import { PYTHON, ROOT } from "../comptoir/launch.ts";
import { BM25Index } from "../comptoir/retrieval.ts";

export const RESULTS = join(ROOT, "ch11", "results");
export const CONTEXTS = join(RESULTS, "contexts.json");
const PYTHON_CONTEXTS = join(PYTHON, "ch11", "results", "contexts.json");

export function loadQuestions(): DocCase[] {
  const cases = JSON.parse(readFileSync(join(PYTHON, "ch11", "questions.json"), "utf8")) as Parameters<typeof makeDocCase>[0][];
  return cases.map(makeDocCase);
}

/** The base with its context sentences, if they have already been computed (here, or by the Python version). */
export function contextualizedBase(): Chunk[] | null {
  const path = [CONTEXTS, PYTHON_CONTEXTS].find(existsSync);
  if (!path) return null;
  return withContexts(loadKnowledge(), JSON.parse(readFileSync(path, "utf8")) as Record<string, string>);
}

export function bm25Index(contextual = true): BM25Index {
  const base = contextual ? contextualizedBase() : null;
  return new BM25Index(base?.length ? base : loadKnowledge());
}
