// Chapter 11: writing, for each chunk of the base, the sentence that situates it in its document.
//
// It is Anthropic's “Contextual Retrieval” method. The whole document is sent with a cache point; from the
// second chunk to the last, it is read from the cache. The sentences are kept in
// ch11/results/contexts.json: they are only recomputed if a document changes.
//
// Run, from the typescript/ folder:  npx tsx ch11/contextualize.ts
// Model: Claude Haiku 5.5. Cost: about forty short calls.

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cost } from "../comptoir/costs.ts";
import { FOLDER, split } from "../comptoir/knowledge.ts";
import { AUXILIARY_MODEL, contextualize } from "../comptoir/retrieval.ts";
import { CONTEXTS } from "./shared.ts";

const client = new Anthropic();
const all: Record<string, string> = {};
let total = 0;
console.log(
  `${"document".padEnd(22)} ${"chunks".padStart(8)} ${"written".padStart(7)} ${"read".padStart(7)} ${"input".padStart(7)} ${"output".padStart(7)} ${"cost ($)".padStart(9)}`,
);
for (const file of readdirSync(FOLDER).filter((f) => f.endsWith(".md")).sort()) {
  const name = file.slice(0, -3);
  // The document as Python reads it (read_text): line endings brought back to “\n”.
  const text = readFileSync(join(FOLDER, file), "utf8").replace(/\r\n?/g, "\n");
  const chunks = split(text, name);
  const [contexts, usages] = await contextualize(client, text, chunks);
  const prices = usages.map((u) => cost(AUXILIARY_MODEL, u));
  const sum = (field: (p: (typeof prices)[number]) => number): number => prices.reduce((s, p) => s + field(p), 0);
  total += sum((p) => p.dollars);
  console.log(
    `${name.padEnd(22)} ${String(chunks.length).padStart(8)} ${String(sum((p) => p.cacheWrite)).padStart(7)} ` +
      `${String(sum((p) => p.cacheRead)).padStart(7)} ${String(sum((p) => p.input)).padStart(7)} ` +
      `${String(sum((p) => p.output)).padStart(7)} ${sum((p) => p.dollars).toFixed(5).padStart(9)}`,
  );
  Object.assign(all, contexts);
}
mkdirSync(dirname(CONTEXTS), { recursive: true });
writeFileSync(CONTEXTS, JSON.stringify(all, null, 1), "utf8"); // like json.dumps(…, indent=1)
console.log(`\n${Object.keys(all).length} contexts written to ${CONTEXTS}; total cost: $${total.toFixed(5)}`);
const [id, sentence] = Object.entries(all)[0]!;
console.log(`Example, ${id}:\n  ${sentence}`);
