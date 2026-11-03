// The retrieval: BM25, embeddings, rank fusion, reranking and context by Claude, without a paid call
// (python/tests/test_retrieval.py), and the same rankings as the Python version.

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, mock, test } from "node:test";
import { contextualizedBase, loadQuestions } from "../ch11/shared.ts";
import type { ReceivedMessage } from "../comptoir/client.ts";
import { type Chunk, forRetrieval, loadKnowledge } from "../comptoir/knowledge.ts";
import { PYTHON } from "../comptoir/launch.ts";
import {
  BM25Index,
  VectorIndex,
  contextRequest,
  contextualize,
  fuse,
  recall,
  rerank,
  rerankingRequest,
  voyageEmbedder,
  words,
} from "../comptoir/retrieval.ts";
import { approx, fakeMessage, temporaryLog } from "./fake_clients.ts";

beforeEach(() => {
  temporaryLog();
});

const chunk = (id: string, text: string): Chunk => ({ id, document: "doc", title: id, text, context: "" });

test("the words of a question", () => {
  assert.deepEqual(words("Are you open on Sundays?"), ["open", "sunday"]);
  // The singular and the plural give the same form on both sides.
  assert.deepEqual(words("The bottles and the price"), ["bottle", "price"]);
  assert.deepEqual(words("the bottle, the prices"), ["bottle", "price"]);
  assert.deepEqual(words("Œuf’s"), ["ufs"]); // outside ASCII, everything disappears, like encode("ascii", "ignore")
});

test("BM25 finds the exact word", () => {
  const results = new BM25Index(loadKnowledge()).search("Do you deliver to Godomey?", 3).map(([c]) => c.id);
  // “Godomey” appears only in the zones page: it comes first. The FAQ question on deliveries outside
  // Cotonou, shorter, which shares “deliver” with the question, comes second.
  assert.deepEqual(results.slice(0, 2), ["kb://delivery-zones#outside-cotonou", "kb://faq#do-you-deliver-outside-cotonou"]);
});

test("BM25: a rare word counts more than a common word", () => {
  const index = new BM25Index([chunk("a", "juice juice juice"), chunk("b", "juice soursop"), chunk("c", "juice pineapple")]);
  assert.equal(index.search("juice soursop", 1)[0]![0].id, "b");
  assert.deepEqual(index.search("the and of"), []); // only stop words: no result, rather than a random one
});

test("embeddings search by meaning", async () => {
  const vectors: Record<string, number[]> = { delivery: [1, 0], payment: [0, 1], "when do you deliver": [0.9, 0.1] };
  const calls: string[] = [];
  const embed = (texts: string[], inputType: string): number[][] => {
    calls.push(inputType);
    return texts.map((t) => vectors[t.split(" ").at(-1)!] ?? vectors[t]!);
  };
  const index = await VectorIndex.create([chunk("d", "delivery"), chunk("p", "payment")], embed);
  assert.equal((await index.search("when do you deliver", 1))[0]![0].id, "d");
  assert.deepEqual(calls, ["document", "query"]); // Voyage tells documents from questions
});

test("the Voyage embedder calls MongoDB's API", async () => {
  const seen: { url?: string; headers?: Record<string, string>; body?: unknown } = {};
  const fake = mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    Object.assign(seen, { url, headers: init.headers, body: JSON.parse(String(init.body)) });
    const response = { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] };
    return new Response(JSON.stringify(response), { status: 200 });
  });
  try {
    const vectors = await voyageEmbedder("voyage-4", "test-key")(["a", "b"], "document");
    assert.deepEqual(vectors, [[1, 0], [0, 1]]); // put back in the order of the texts
    assert.equal(seen.url, "https://ai.mongodb.com/v1/embeddings");
    assert.equal(seen.headers!.Authorization, "Bearer test-key");
    assert.deepEqual(seen.body, { input: ["a", "b"], model: "voyage-4", input_type: "document" });
    fake.mock.mockImplementation(async () => new Response("{}", { status: 401 }));
    await assert.rejects(async () => voyageEmbedder("voyage-4", "wrong")(["a"], "query"), /HTTP 401/);
  } finally {
    fake.mock.restore();
  }
});

test("rank fusion", () => {
  const [a, b, c] = [chunk("a", ""), chunk("b", ""), chunk("c", "")];
  const lexical: [Chunk, number][] = [[a, 12], [b, 3]];
  const semantic: [Chunk, number][] = [[b, 0.91], [c, 0.9]];
  const fusion = fuse([lexical, semantic], { keep: 3 });
  assert.deepEqual(fusion.map(([x]) => x.id), ["b", "a", "c"]); // b, well placed twice, comes first
});

test("recall", () => {
  assert.ok(recall([[chunk("a", ""), 1]], ["x", "a"]) && !recall([], ["a"]));
});

class FakeClient {
  readonly requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  readonly messages = this;
  constructor(private readonly texts: string[]) {}
  async create(request: Anthropic.MessageCreateParamsNonStreaming): Promise<ReceivedMessage> {
    this.requests.push(request);
    return fakeMessage({ content: [{ type: "text", text: this.texts.shift()!, citations: null }], usage: { input_tokens: 100, output_tokens: 20 }, id: "req" });
  }
  async countTokens(): Promise<Anthropic.MessageTokensCount> {
    throw new Error("not used");
  }
}

test("the reranking discards the unknown IDs", async () => {
  const candidates = [chunk("a", "one"), chunk("b", "two"), chunk("c", "three")];
  const client = new FakeClient([JSON.stringify({ relevant: ["c", "unknown", "a", "c"] })]);
  const [chosen, price] = await rerank(client, "?", candidates, 3);
  assert.deepEqual(chosen.map((c) => c.id), ["c", "a"]);
  approx(price, (100 * 0.1 + 20 * 0.5) / 1e6); // Haiku 5.5
  assert.equal((client.requests[0]!.output_config!.format as { type: string }).type, "json_schema");
  assert.deepEqual(await rerank(new FakeClient([]), "?", []), [[], 0]);
});

test("the reranking request asks for no answer", () => {
  const request = rerankingRequest("Do you deliver?", [chunk("a", "text")], 3);
  assert.equal(request.model, "claude-haiku-5-5");
  assert.ok(String(request.messages[0]!.content).includes('<passage id="a">'));
});

test("the document to contextualize is cached", () => {
  const request = contextRequest("The whole document.", chunk("a", "A passage."));
  const [document, instruction] = request.messages[0]!.content as Anthropic.TextBlockParam[];
  assert.deepEqual(document!.cache_control, { type: "ephemeral" });
  assert.ok(document!.text.includes("The whole document."));
  assert.ok(!("cache_control" in instruction!) && instruction!.text.includes("A passage."));
});

test("contextualize: one call per chunk", async () => {
  const client = new FakeClient([" Situates a. ", "Situates b."]);
  const [contexts, usages] = await contextualize(client, "doc", [chunk("a", "x"), chunk("b", "y")]);
  assert.deepEqual(contexts, { a: "Situates a.", b: "Situates b." });
  assert.equal(usages.length, 2);
  // The same document, identical, in each request: that is what allows reading from the cache.
  const first = (r: Anthropic.MessageCreateParamsNonStreaming): unknown => (r.messages[0]!.content as unknown[])[0];
  assert.deepEqual(first(client.requests[0]!), first(client.requests[1]!));
});

// --- The same rankings as the Python version -------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
const withoutPython = { skip: PYTHON_VENV ? false : "Python environment missing" };
const python = (script: string, input: unknown = null): unknown =>
  JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script], {
      cwd: PYTHON,
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    }),
  );

test("the same words and the same BM25 scores as the Python version, on the 20 questions", withoutPython, () => {
  const questions = loadQuestions().map((c) => c.question);
  const contextualized = contextualizedBase();
  assert.ok(contextualized, "the contexts of the Python version are in the repository");
  const rankings = (base: Chunk[]): [string, number][][] => {
    const index = new BM25Index(base);
    return questions.map((q) => index.search(q, 10).map(([c, s]): [string, number] => [c.id, s]));
  };
  const expected = python(
    `
import json, sys
from ch11.shared import contextualized_base
from comptoir.knowledge import load_knowledge
from comptoir.retrieval import BM25Index, words
questions = json.load(sys.stdin)
def rankings(base):
    index = BM25Index(base)
    return [[[c.id, s] for c, s in index.search(q, 10)] for q in questions]
print(json.dumps({"words": [words(q) for q in questions] + [words(c.for_retrieval()) for c in load_knowledge()],
                  "raw": rankings(load_knowledge()), "contextual": rankings(contextualized_base())}))`,
    questions,
  ) as { words: string[][]; raw: [string, number][][]; contextual: [string, number][][] };
  assert.deepEqual([...questions.map(words), ...loadKnowledge().map((c) => words(forRetrieval(c)))], expected.words);
  // The same chunks, in the same order; the scores to within 10^-12: V8's Math.log and Python's sometimes
  // differ in the last bit (72 logarithms out of 1,141 tried on October 23, 2026).
  for (const [got, wanted] of [[rankings(loadKnowledge()), expected.raw], [rankings(contextualized), expected.contextual]] as const) {
    assert.deepEqual(got.map((r) => r.map(([id]) => id)), wanted.map((r) => r.map(([id]) => id)));
    got.forEach((r, i) => r.forEach(([, s], j) => assert.ok(Math.abs(s - wanted[i]![j]![1]) <= 1e-12 * s, `${s} ≠ ${wanted[i]![j]![1]}`)));
  }
});

test("the same cosine scores and the same fusion as the Python version", withoutPython, async () => {
  // Vectors drawn from a fixed seed, the same on both sides.
  let seed = 7;
  const rng = (): number => ((seed = (seed * 48271) % 2147483647) / 2147483647) * 2 - 1;
  const base = loadKnowledge();
  const vectors = base.map(() => Array.from({ length: 64 }, rng));
  const question = Array.from({ length: 64 }, rng);
  const embed = (texts: string[], type: string): number[][] => (type === "query" ? [question] : vectors);
  const index = await VectorIndex.create(base, embed);
  const semantic = await index.search("?", 41);
  const lexical = new BM25Index(base).search("Do you deliver on Sundays to Godomey?", 20);
  const fusion = fuse([lexical, semantic.slice(0, 20)], { keep: 8 });
  const expected = python(
    `
import json, sys
from comptoir.knowledge import load_knowledge
from comptoir.retrieval import BM25Index, VectorIndex, fuse
d = json.load(sys.stdin)
base = load_knowledge()
index = VectorIndex(base, lambda texts, t: [d["question"]] if t == "query" else d["vectors"])
semantic = index.search("?", 41)
lexical = BM25Index(base).search("Do you deliver on Sundays to Godomey?", 20)
fusion = fuse(lexical, semantic[:20], keep=8)
print(json.dumps({"semantic": [[c.id, s] for c, s in semantic], "fusion": [[c.id, s] for c, s in fusion]}))`,
    { vectors, question },
  ) as { semantic: [string, number][]; fusion: [string, number][] };
  assert.deepEqual(semantic.map(([c, s]) => [c.id, s]), expected.semantic);
  assert.deepEqual(fusion.map(([c, s]) => [c.id, s]), expected.fusion);
});

test("the same reranking and context requests as the Python version", withoutPython, () => {
  const base = loadKnowledge();
  const document = readFileSync(join(PYTHON, "comptoir", "knowledge", "faq.md"), "utf8").replace(/\r\n?/g, "\n");
  const expected = python(`
import json
from comptoir.knowledge import FOLDER, load_knowledge
from comptoir.retrieval import context_request, reranking_request
base = load_knowledge()
print(json.dumps([reranking_request("Do you deliver to Godomey?", base[:6], 3), context_request((FOLDER / "faq.md").read_text(encoding="utf-8"), base[2])]))`);
  assert.deepEqual([rerankingRequest("Do you deliver to Godomey?", base.slice(0, 6), 3), contextRequest(document, base[2]!)], expected);
});
