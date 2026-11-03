// Chapter 7: measure the extractor's accuracy on a set of documents whose answer is known.
//
// The documents and the expected values are those of the Python version (python/ch07/documents/,
// expected.json). For your own set, write them before the first trial, and set the accuracy target
// before measuring.
//
// Run, from the typescript/ folder:
//     npx tsx ch07/measure_accuracy.ts --repetitions 3 --max-budget 0.5
//     npx tsx ch07/measure_accuracy.ts --max-side 1000 --repetitions 3 --max-budget 0.5

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Gap, compare, summarize } from "../comptoir/accuracy.ts";
import type { MessagesClient } from "../comptoir/client.ts";
import { documentBlock } from "../comptoir/documents.ts";
import { Invoice, extract, schemaFor } from "../comptoir/extraction.ts";
import { PYTHON, isMain } from "../comptoir/launch.ts";

export const DOCUMENTS = join(PYTHON, "ch07", "documents");

type Expected = Parameters<typeof compare>[1];

export async function measure(
  client: MessagesClient,
  expected: Record<string, Expected>,
  repetitions: number,
  maxBudget: number,
  maxSide: number | null = null,
): Promise<{ gaps: Gap[]; spent: number; failures: [string, string][] }> {
  const gaps: Gap[] = [];
  const failures: [string, string][] = [];
  let spent = 0;
  for (let r = 0; r < repetitions; r++) {
    for (const [name, expectedValues] of Object.entries(expected)) {
      if (spent >= maxBudget) {
        console.log(`Budget reached ($${spent.toFixed(4)}): stopping.`);
        return { gaps, spent, failures };
      }
      const schema = schemaFor(name);
      const result = await extract(client, [await documentBlock(join(DOCUMENTS, name), maxSide)], schema);
      spent += result.cost.dollars;
      if (result.error) failures.push([name, result.error]);
      gaps.push(...compare(name, expectedValues, result.data as Expected | null, schema === Invoice));
    }
  }
  return { gaps, spent, failures };
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      repetitions: { type: "string", default: "1" },
      "max-budget": { type: "string", default: "0.5" }, // in dollars
      "max-side": { type: "string" },
    },
  });
  const expected = JSON.parse(readFileSync(join(DOCUMENTS, "expected.json"), "utf8")) as Record<string, Expected>;
  const maxSide = args["max-side"] ? Number(args["max-side"]) : null;
  const { gaps, spent, failures } = await measure(new Anthropic(), expected, Number(args.repetitions), Number(args["max-budget"]), maxSide);
  const s = summarize(gaps);
  console.log(`\nFields graded: ${s.fields}  —  accuracy: ${(s.accuracy * 100).toFixed(1)}%  —  spent: $${spent.toFixed(4)}`);
  console.log(`correct ${s.correct}, missed ${s.missed}, invented ${s.invented}, wrong ${s.wrong}`);
  for (const g of gaps) {
    if (g.outcome !== "correct") console.log(`  ${g.outcome.padEnd(9)} ${g.document} ${g.field}: expected ${JSON.stringify(g.expected)}, obtained ${JSON.stringify(g.obtained)}`);
  }
  for (const [name, error] of failures) console.log(`  failure   ${name}: ${error}`);
}

if (isMain(import.meta.url)) await main();
