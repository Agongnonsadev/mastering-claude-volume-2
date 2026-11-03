// Chapter 13: Awa approves or rejects an order proposed by the agent, and can leave it feedback.
//
// Run, from the typescript/ folder:
//     npx tsx ch13/approve_order.ts --orders orders.json --list
//     npx tsx ch13/approve_order.ts --orders orders.json BC-1a2b3c --approve
//     npx tsx ch13/approve_order.ts --orders orders.json BC-1a2b3c --reject --note "..." --memory workshop_memory
//
// The decision goes through no model: it is the only path that takes an order out of “to be approved”. The
// note, if a memory folder is given, is added to the file that the agent will read next Monday. It is the
// code that writes it, not the agent.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isMain } from "../comptoir/launch.ts";
import { Workshop, renderOrder } from "../comptoir/workshop.ts";

export const FEEDBACK_FILE = "awa-feedback.md";

export function leaveFeedback(memory: string, code: string, decision: string, note: string, day: string): string {
  // The SDK's memory tool serves the “memories” subfolder of the folder given: that is where to write.
  const root = join(memory, "memories");
  mkdirSync(root, { recursive: true });
  const path = join(root, FEEDBACK_FILE);
  if (!existsSync(path)) writeFileSync(path, "# Awa's feedback on purchase orders\n\n", "utf8");
  appendFileSync(path, `- ${day}, order ${code} ${decision}: ${note}\n`, "utf8");
  return path;
}

/** argparse's parser.error(): the message, then the exit with code 2. */
function usageError(message: string): never {
  console.error(`usage: approve_order --orders ORDERS [code] [--approve | --reject | --list] [--note NOTE] [--memory MEMORY]\nerror: ${message}`);
  process.exit(2);
}

function main(): void {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      orders: { type: "string" },
      approve: { type: "boolean", default: false },
      reject: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      note: { type: "string" },
      memory: { type: "string" }, // the agent's memory folder
    },
  });
  if (!args.orders) usageError("the following arguments are required: --orders");
  if ([args.approve, args.reject, args.list].filter(Boolean).length > 1) usageError("--approve, --reject and --list are mutually exclusive");
  const code = positionals[0];
  const workshop = new Workshop({ orders: args.orders });
  if (args.list || !code) {
    for (const order of workshop.orders()) console.log(renderOrder(order) + "\n");
    return;
  }
  if (!(args.approve || args.reject)) usageError("--approve or --reject");
  const order = workshop.decide(code, args.approve, args.note ?? null);
  console.log(renderOrder(order));
  if (args.note && args.memory) console.log(`Feedback left in ${leaveFeedback(args.memory, order.code, order.status, args.note, workshop.today)}`);
}

if (isMain(import.meta.url)) main();
