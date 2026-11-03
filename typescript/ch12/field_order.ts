// Chapter 12: does the evaluator tick before or after writing its critique? 40 calls.
//
// Two replies to a complaint: one compliant, the other promising a delivery. Each is reviewed ten times by
// Claude Haiku 5.5 with the evaluation schema, the boxes first then the critique first. A structured output
// follows the order of the schema's required properties: the box “promises_something” is therefore filled
// in before, or after, the opinion. Cost: less than a cent.
//
// Run, from the typescript/ folder:  npx tsx ch12/field_order.ts

import Anthropic from "@anthropic-ai/sdk";
import { textOf } from "../comptoir/client.ts";
import { AUXILIARY_MODEL as MODEL, EVALUATION_SCHEMA, EVALUATION_SYSTEM } from "../comptoir/complaints.ts";
import { cost } from "../comptoir/costs.ts";
import { isMain } from "../comptoir/launch.ts";
import { logCall } from "../comptoir/log.ts";

const COMPLIANT =
  "We are truly sorry about this missing bottle in your delivery. Your complaint has been passed on to " +
  "Awa, who will reply within 24 hours, in accordance with our terms of sale. " +
  "Could you tell us which product was concerned?";
const PROMISE =
  "We are truly sorry about this missing bottle. Your complaint has been passed on to Awa, " +
  "who will reply within 24 hours, and the bottle will be delivered to you as early as tomorrow.";

type Schema = typeof EVALUATION_SCHEMA;

/** The Comptoir's schema (critique first), or its first version (boxes first). */
export function schema(critiqueFirst: boolean): Schema {
  const s = structuredClone(EVALUATION_SCHEMA);
  if (!critiqueFirst) {
    const { critique, ...boxes } = s.properties;
    s.properties = { ...boxes, critique } as Schema["properties"];
    s.required = [...s.required.filter((k) => k !== "critique"), "critique"];
  }
  return s;
}

async function review(client: Anthropic, text: string, critiqueFirst: boolean): Promise<[Record<string, unknown>, number]> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: EVALUATION_SYSTEM,
    messages: [{ role: "user", content: `<answer>${text}</answer>` }],
    output_config: { format: { type: "json_schema", schema: schema(critiqueFirst) } },
  });
  const price = cost(MODEL, response.usage);
  logCall(response._request_id, MODEL, price, { prompt: "ch12-field-order", stop_reason: response.stop_reason });
  return [JSON.parse(textOf(response)) as Record<string, unknown>, price.dollars];
}

/** count times the same task, at most maximum at a time, like a ThreadPoolExecutor(max_workers=maximum). */
async function inParallel<T>(count: number, maximum: number, task: () => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(count);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count) {
      const i = next++;
      results[i] = await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(maximum, count) }, worker));
  return results;
}

async function main(): Promise<void> {
  const client = new Anthropic();
  let total = 0;
  for (const [name, text] of [["compliant reply", COMPLIANT], ["promising reply", PROMISE]] as const) {
    for (const critiqueFirst of [false, true]) {
      const results = await inParallel(10, 5, () => review(client, text, critiqueFirst));
      total += results.reduce((s, [, price]) => s + price, 0);
      const promises = results.filter(([j]) => j.promises_something).length;
      const order = critiqueFirst ? "critique first" : "boxes first";
      const [first] = results[0]!;
      console.log(`${name.padEnd(20)} ${order.padEnd(17)}: “promises” ticked ${promises} times out of 10; first field returned: ${Object.keys(first)[0]}`);
      console.log(`${"".padEnd(20)} example of critique: ${[...String(first.critique)].slice(0, 150).join("")}`);
    }
  }
  console.log(`\nCost: $${total.toFixed(4)}`);
}

if (isMain(import.meta.url)) await main();
