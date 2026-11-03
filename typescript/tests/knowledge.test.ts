// Awa's base: splitting, stable IDs, search_result blocks and cache breakpoint
// (python/tests/test_knowledge.py), and the same base as the Python version.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { anchor, forRetrieval, loadKnowledge, resultBlock, resultBlocks, split, withContexts } from "../comptoir/knowledge.ts";
import { PYTHON } from "../comptoir/launch.ts";

const DOCUMENT = `# Frequently asked questions

Fictional document.

## Are you open on Sundays?

No. On Sundays, the workshop is closed.

## How do I pay?

By Mobile Money.

In cash too.
`;

test("the anchor of a title", () => {
  assert.equal(anchor("Are you open on Sundays?"), "are-you-open-on-sundays");
  assert.equal(anchor("Délices d'Awa's events"), "delices-d-awa-s-events");
});

test("one section per chunk", () => {
  const chunks = split(DOCUMENT, "faq");
  assert.deepEqual(chunks.map((c) => c.id), ["kb://faq#are-you-open-on-sundays", "kb://faq#how-do-i-pay"]);
  assert.equal(chunks[0]!.title, "Frequently asked questions — Are you open on Sundays?");
  assert.equal(chunks[1]!.text, "By Mobile Money.\n\nIn cash too.");
});

test("a section that is too long is cut, with overlap", () => {
  const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} ${"x".repeat(80)}`);
  const chunks = split(`# Doc\n\n## Long\n\n${paragraphs.join("\n\n")}`, "doc", 250);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0]!.id, "kb://doc#long-1");
  // Each part takes up the last paragraph of the previous one.
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i]!.text.startsWith(chunks[i - 1]!.text.split("\n\n").at(-1)!));
});

test("Awa's base", () => {
  const base = loadKnowledge();
  const ids = base.map((c) => c.id);
  assert.equal(base.length, 41);
  assert.equal(new Set(ids).size, 41);
  assert.deepEqual(ids, loadKnowledge().map((c) => c.id)); // stable order, condition of the cache
  assert.ok(ids.includes("kb://delivery-zones#outside-cotonou"));
});

test("the expected sources of the questions exist", () => {
  const questions = JSON.parse(readFileSync(join(PYTHON, "ch11", "questions.json"), "utf8")) as { sources?: string[] }[];
  const ids = new Set(loadKnowledge().map((c) => c.id));
  const missing = questions.flatMap((q) => q.sources ?? []).filter((s) => !ids.has(s));
  assert.deepEqual(missing, []);
});

test("a search_result block", () => {
  const block = resultBlock(split(DOCUMENT, "faq")[1]!);
  assert.equal(block.type, "search_result");
  assert.equal(block.source, "kb://faq#how-do-i-pay");
  assert.deepEqual(block.citations, { enabled: true });
  assert.deepEqual(block.content, [{ type: "text", text: "By Mobile Money." }, { type: "text", text: "In cash too." }]);
  assert.ok(!("cache_control" in block));
});

test("the cache breakpoint is on the last block only", () => {
  assert.deepEqual(resultBlocks(split(DOCUMENT, "faq"), true).map((b) => "cache_control" in b), [false, true]);
  assert.ok(resultBlocks(split(DOCUMENT, "faq")).every((b) => !("cache_control" in b)));
});

test("the contexts are added to the retrieval", () => {
  const chunk = split(DOCUMENT, "faq")[0]!;
  const situated = withContexts([chunk], { [chunk.id]: "Opening hours of the shop." })[0]!;
  assert.ok(forRetrieval(situated).startsWith("Opening hours of the shop."));
  assert.deepEqual(resultBlock(situated).content, resultBlock(chunk).content); // Claude reads the text, not the context
});

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

test("the same base as the Python version, chunk by chunk", { skip: PYTHON_VENV ? false : "Python environment missing" }, () => {
  const script = "import json\nfrom comptoir.knowledge import load_knowledge\nprint(json.dumps([[c.id, c.title, c.text] for c in load_knowledge()], ensure_ascii=False))";
  const python = JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script], { cwd: PYTHON, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }));
  assert.deepEqual(loadKnowledge().map((c) => [c.id, c.title, c.text]), python);
});
