// Chapter 9: talk to the Comptoir in the terminal, and place an order with it.
//
// Run, from the typescript/ folder:  npx tsx ch09/comptoir_orders.ts
// Type your messages as a customer; an empty line to quit. To confirm a summary, reply “YES” followed by
// the code shown.
//
// The shop (stock, summaries, orders) lives in customer_data/shop.sqlite3.

import { createInterface } from "node:readline/promises";
import { Budget } from "../comptoir/budget.ts";
import { makeClient } from "../comptoir/call.ts";
import { config } from "../comptoir/config.ts";
import { randomId } from "../comptoir/database.ts";
import { ComptoirError } from "../comptoir/errors.ts";
import { ComptoirOrders } from "../comptoir/orders.ts";
import { Shop } from "../comptoir/shop.ts";

const SHOP = "customer_data/shop.sqlite3";

const comptoir = new ComptoirOrders(makeClient(), new Shop(SHOP), new Budget(config.BUDGET_DB), randomId());
const keyboard = createInterface({ input: process.stdin, output: process.stdout });
console.log("Awa's Comptoir — an empty line to quit.\n");
for (let text = (await keyboard.question("You: ")).trim(); text; text = (await keyboard.question("You: ")).trim()) {
  try {
    const answer = await comptoir.answer(text);
    console.log(`Comptoir: ${answer.text}\n`);
    if (answer.turn?.execution.calls.length) console.log(`  (tools called: ${answer.turn.execution.calls.join(", ")})\n`);
  } catch (error) {
    if (!(error instanceof ComptoirError)) throw error;
    console.log(`Comptoir: ${error.diagnostic.forCustomer}\n  (for Yao: ${error.diagnostic.forYao})\n`);
  }
}
keyboard.close();
