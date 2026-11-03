// Chapter 11: the Comptoir of chapter 9, with Awa's documents, without cache then with.
//
// The same conversation, several times, with a new shop each time: a question about the documents, a
// stock question, an order, the confirmation. We count the calls, the tokens read and written in the
// cache, and the cost of each message.
//
// Run, from the typescript/ folder:
//     npx tsx ch11/comptoir_with_knowledge.ts                   (without cache, then 5-minute cache)
//     npx tsx ch11/comptoir_with_knowledge.ts --variants 1h     (common beginning kept one hour)

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Budget } from "../comptoir/budget.ts";
import { makeClient } from "../comptoir/call.ts";
import { config } from "../comptoir/config.ts";
import { randomId } from "../comptoir/database.ts";
import { type Cache, loadKnowledge } from "../comptoir/knowledge.ts";
import { multipleValues } from "../comptoir/launch.ts";
import { ComptoirOrders } from "../comptoir/orders.ts";
import { Shop } from "../comptoir/shop.ts";

const MESSAGES = [
  "Hello, how long does a juice keep once opened?",
  "Do you still have pineapple juice and soursop juice?",
  "Then 6 bottles of pineapple, delivered to Akpakpa, in the name of Mrs. Hounkpè.",
  "YES {code}",
];
const VARIANTS: Record<string, [Cache, string]> = {
  none: [false, "without cache"],
  "5m": [true, "5-minute cache"],
  "1h": ["1h", "common beginning kept one hour"],
};

function logLines(since: number): Record<string, unknown>[] {
  try {
    return readFileSync(config.LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(since);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function play(cache: Cache, name: string): Promise<number> {
  const comptoir = new ComptoirOrders(makeClient(), new Shop(":memory:"), new Budget(":memory:"), randomId(), {
    promptVersion: "v3",
    knowledge: loadKnowledge(),
    cache,
  });
  console.log(`\n=== ${name} ===`);
  let code: string | null = null;
  let total = 0;
  for (const template of MESSAGES) {
    const text = template.replace("{code}", code ?? "None"); // like format(code=None) in Python
    const before = logLines(0).length;
    const answer = await comptoir.answer(text);
    const calls = logLines(before).filter((l) => "request" in l);
    const spent = calls.reduce((s, l) => s + (l.cost_dollars as number), 0);
    total += spent;
    console.log(`\nCustomer : ${text}\nComptoir : ${answer.text}`);
    if (answer.turn?.execution.calls.length) console.log(`  tools: ${answer.turn.execution.calls.join(", ")}`);
    for (const l of calls) {
      console.log(
        `  call: input ${String(l.input_tokens).padStart(6)}  written ${String(l.cache_write_tokens).padStart(6)}  ` +
          `read ${String(l.cache_read_tokens).padStart(6)}  output ${String(l.output_tokens).padStart(5)}  $${(l.cost_dollars as number).toFixed(5)}`,
      );
    }
    code = /YES (\d{4})/.exec(answer.text)?.[1] ?? code;
  }
  console.log(`\nTotal, ${name}: $${total.toFixed(4)}`);
  return total;
}

const { values: args } = parseArgs({
  args: multipleValues(["variants"]),
  options: { variants: { type: "string", multiple: true, default: ["none", "5m"] } },
});
const unknown = args.variants.filter((v) => !(v in VARIANTS));
if (unknown.length) throw new Error(`--variants: ${unknown.join(", ")}? Choices: ${Object.keys(VARIANTS).join(", ")}.`);
// Without cache, each call reads the whole base at full price: the quota of chapter 8 ($0.15 per customer
// per day) would stop the conversation halfway. We raise it for this measurement.
console.log(`Quota per customer raised from $${config.CUSTOMER_DAILY_QUOTA} to $1 for the measurement.`);
config.CUSTOMER_DAILY_QUOTA = 1.0;
const totals = new Map<string, number>();
for (const variant of args.variants) {
  const [cache, name] = VARIANTS[variant]!;
  totals.set(name, await play(cache, name));
}
console.log("\n" + [...totals].map(([name, t]) => `${name}: $${t.toFixed(4)}`).join("; "));
