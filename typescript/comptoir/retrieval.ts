// Finding the right passages when the base no longer fits in the context (chapter 11).
//
// - BM25Index: lexical search, which finds the exact words (“Godomey”, “48 hours”).
// - VectorIndex: search by meaning, with embeddings. Anthropic does not provide any: the function that
//   computes them is passed as a parameter (Voyage AI, or a fake one for the tests).
// - fuse: hybrid search, which combines several rankings (rank fusion).
// - rerank: Claude rereads the best candidates and keeps the most useful.
// - contextualize: Claude writes, for each chunk, the sentence that situates it in its document
//   (Contextual Retrieval), reading the document from the cache.
//
// Everything is written here, without a dependency: a base of a few thousand chunks needs neither a
// vector database nor a search library.

import type Anthropic from "@anthropic-ai/sdk";
import { type MessagesClient, textOf } from "./client.ts";
import { cost } from "./costs.ts";
import { type Chunk, forRetrieval } from "./knowledge.ts";
import { logCall } from "./log.ts";
import { sum } from "./python.ts";

// Words too frequent to help find anything. The French ones too: the Comptoir answers customers who
// write in French.
const STOP_WORDS = new Set(
  `a about am an and any are as at be been but by can could did do does for from had has have how i if in
into is it its me my no not of on or our so than that the their them then there these they this to us
was we were what when where which who why will with would you your
au aux avec ce ces cet cette d dans de des du elle en est et etre il ils j je l la le les leur
leurs lui m ma mais me mes mon n ne nos notre nous on ou par pas pour qu que quel quelle quelles
quels qui s sa se ses si son sont sur t ta te tes ton tu un une vos votre vous y c ca est-ce`
    .split(/\s+/)
    .filter(Boolean),
);

export type Ranking = [Chunk, number][];

/** Lowercase, without accents, without stop words, and a simple plural brought back to the singular. */
export function words(text: string): string[] {
  // Like encode("ascii", "ignore") in Python: every character outside ASCII disappears, accents included.
  const plain = text.normalize("NFD").replace(/[^\x00-\x7f]/g, "").toLowerCase();
  const result: string[] = [];
  for (let word of plain.match(/[a-z0-9]+/g) ?? []) {
    if (STOP_WORDS.has(word)) continue;
    if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) word = word.slice(0, -1);
    result.push(word);
  }
  return result;
}

/** The chunks by decreasing score; at equal score, the starting order (the sort is stable, as in Python). */
const byScore = (a: [Chunk, number], b: [Chunk, number]): number => b[1] - a[1];

/**
 * BM25: the frequency of a word in the chunk counts, but less and less (k1), rare words count more than
 * common words (idf), and a long chunk does not win just because it is long (b).
 */
export class BM25Index {
  readonly terms: Map<string, number>[];
  readonly lengths: number[];
  readonly averageLength: number;
  readonly idf = new Map<string, number>();

  constructor(
    readonly chunks: Chunk[],
    readonly k1 = 1.5,
    readonly b = 0.75,
  ) {
    this.terms = chunks.map((c) => {
      const count = new Map<string, number>();
      for (const word of words(forRetrieval(c))) count.set(word, (count.get(word) ?? 0) + 1);
      return count;
    });
    this.lengths = this.terms.map((t) => [...t.values()].reduce((x, y) => x + y, 0));
    this.averageLength = chunks.length ? this.lengths.reduce((x, y) => x + y, 0) / chunks.length : 0;
    const frequencies = new Map<string, number>();
    for (const t of this.terms) for (const word of t.keys()) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    const n = chunks.length;
    // V8's Math.log and Python's sometimes differ in the last bit: scores equal to within 10^-15.
    for (const [word, f] of frequencies) this.idf.set(word, Math.log(1 + (n - f + 0.5) / (f + 0.5)));
  }

  score(i: number, question: string[]): number {
    const terms = this.terms[i]!;
    const length = this.lengths[i]!;
    let total = 0;
    for (const word of question) {
      const f = terms.get(word) ?? 0;
      if (f) {
        const norm = 1 - this.b + (this.b * length) / this.averageLength;
        total += (this.idf.get(word)! * f * (this.k1 + 1)) / (f + this.k1 * norm);
      }
    }
    return total;
  }

  search(question: string, k = 5): Ranking {
    const q = words(question);
    const scores: Ranking = this.chunks.map((c, i) => [c, this.score(i, q)]);
    return scores.filter((s) => s[1] > 0).sort(byScore).slice(0, k);
  }
}

/** (texts, "document" or "query") -> vectors. A network call, hence a promise. */
export type Embedder = (texts: string[], inputType: "document" | "query") => Promise<number[][]> | number[][];

/**
 * Search by meaning: the question and the chunks become vectors, and we keep the chunks whose vector is
 * closest to the question's. The chunks' vectors are computed at creation: VectorIndex.create(), to
 * await.
 */
export class VectorIndex {
  private constructor(
    readonly chunks: Chunk[],
    readonly embed: Embedder,
    readonly vectors: number[][],
  ) {}

  static async create(chunks: Chunk[], embed: Embedder): Promise<VectorIndex> {
    return new VectorIndex(chunks, embed, await embed(chunks.map(forRetrieval), "document"));
  }

  async search(question: string, k = 5): Promise<Ranking> {
    const q = (await this.embed([question], "query"))[0]!;
    const n = Math.min(this.chunks.length, this.vectors.length);
    const scores: Ranking = this.chunks.slice(0, n).map((c, i) => [c, cosine(q, this.vectors[i]!)]);
    return scores.sort(byScore).slice(0, k);
  }
}

/** The sums like Python's sum(): scores identical to the bit. */
function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const product = sum(a.slice(0, n).map((x, i) => x * b[i]!));
  const norms = Math.sqrt(sum(a.map((x) => x * x))) * Math.sqrt(sum(b.map((y) => y * y)));
  return norms ? product / norms : 0;
}

/**
 * Voyage AI's embeddings, through MongoDB Atlas's HTTP API (key in VOYAGE_API_KEY). Paid per token: count
 * the texts before indexing a large base.
 */
export function voyageEmbedder(model = "voyage-4", key: string | null = null, url = "https://ai.mongodb.com/v1/embeddings"): Embedder {
  const token = key || process.env.VOYAGE_API_KEY;
  if (!token) throw new Error("VOYAGE_API_KEY is not set.");
  return async (texts, inputType) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ input: texts, model, input_type: inputType }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Voyage AI: HTTP ${response.status}`); // urlopen raises an HTTPError
    const data = (await response.json()) as { data: { index: number; embedding: number[] }[] };
    return [...data.data].sort((x, y) => x.index - y.index).map((d) => d.embedding);
  };
}

/**
 * Rank fusion (reciprocal rank fusion): each index gives 1 / (k + rank) to its chunks. We add up: a chunk
 * well placed by two indexes comes first. Raw scores do not compare from one index to another; ranks do.
 */
export function fuse(rankings: Ranking[], { k = 60, keep = 5 } = {}): Ranking {
  const scores = new Map<string, number>();
  const byId = new Map<string, Chunk>();
  for (const ranking of rankings) {
    ranking.forEach(([chunk], i) => {
      scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (k + i + 1));
      byId.set(chunk.id, chunk);
    });
  }
  return [...scores].sort((a, b) => b[1] - a[1]).slice(0, keep).map(([id, s]) => [byId.get(id)!, s]);
}

// --- Claude at the service of retrieval -----------------------------------------------------------

export const AUXILIARY_MODEL = "claude-haiku-5-5"; // small, high-volume tasks: ranking, situating

export const RERANKING_SCHEMA = {
  type: "object",
  properties: { relevant: { type: "array", items: { type: "string" } } },
  required: ["relevant"],
  additionalProperties: false,
};

export function rerankingRequest(question: string, candidates: Chunk[], keep: number, model = AUXILIARY_MODEL): Anthropic.MessageCreateParamsNonStreaming {
  const passages = candidates.map((c) => `<passage id="${c.id}">\n${c.title}\n${c.text}\n</passage>`).join("\n\n");
  return {
    model,
    max_tokens: 500,
    system:
      "You rank passages of the Délices d'Awa documentation by their usefulness for " +
      "answering a customer's question. You do not answer the question.",
    messages: [
      {
        role: "user",
        content:
          `${passages}\n\n<question>${question}</question>\n\n` +
          `Give the IDs of at most ${keep} passages that help answer, from the most useful to the ` +
          "least useful. If none helps, return an empty list.",
      },
    ],
    output_config: { format: { type: "json_schema", schema: RERANKING_SCHEMA } },
  };
}

/**
 * Claude rereads the candidates and returns the most useful, in order, with the cost in dollars. An
 * unknown ID is discarded: the code does not take on trust a list produced by a model.
 */
export async function rerank(
  client: MessagesClient,
  question: string,
  candidates: Chunk[],
  keep = 3,
  model = AUXILIARY_MODEL,
): Promise<[Chunk[], number]> {
  if (!candidates.length) return [[], 0];
  const message = await client.messages.create(rerankingRequest(question, candidates, keep, model));
  const price = cost(model, message.usage);
  logCall(message._request_id, model, price, { prompt: "reranking" });
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const relevant = (JSON.parse(textOf(message)) as { relevant: unknown[] }).relevant;
  if (!Array.isArray(relevant)) throw new Error("Reranking answer without a “relevant” list.");
  const chosen = [...new Set(relevant.filter((i): i is string => typeof i === "string" && byId.has(i)))];
  return [chosen.slice(0, keep).map((i) => byId.get(i)!), price.dollars];
}

export const contextInstruction = (passage: string): string =>
  `Here is a passage from this document:\n<passage>\n${passage}\n</passage>\n` +
  "Write a short sentence that situates this passage within the whole document, so that it is " +
  "found more easily in a search. Answer only with this sentence.";

/**
 * The whole document first, with a cache point; the passage next. From the second passage to the last,
 * the document is read from the cache, at a fraction of the price.
 */
export function contextRequest(document: string, chunk: Chunk, model = AUXILIARY_MODEL): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `<document>\n${document}\n</document>`, cache_control: { type: "ephemeral" } },
          { type: "text", text: contextInstruction(chunk.text) },
        ],
      },
    ],
  };
}

/**
 * One context sentence per chunk. The calls follow one another, one by one: a cache entry is only
 * available once the first response has started. Also returns the usages, to check that the cache did
 * its job.
 */
export async function contextualize(
  client: MessagesClient,
  document: string,
  chunks: Chunk[],
  model = AUXILIARY_MODEL,
): Promise<[Record<string, string>, Anthropic.Usage[]]> {
  const contexts: Record<string, string> = {};
  const usages: Anthropic.Usage[] = [];
  for (const chunk of chunks) {
    const message = await client.messages.create(contextRequest(document, chunk, model));
    logCall(message._request_id, model, cost(model, message.usage), { prompt: "context" });
    contexts[chunk.id] = textOf(message).trim();
    usages.push(message.usage);
  }
  return [contexts, usages];
}

/** Does the ranking contain at least one of the expected chunks? (recall at k) */
export const recall = (ranking: Ranking, expected: string[]): boolean => ranking.some(([c]) => expected.includes(c.id));
