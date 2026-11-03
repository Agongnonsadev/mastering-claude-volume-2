// Chapter 7: Yao approves the orders extracted from the photos, one by one, before anything is recorded.
//
// Nothing is recorded without a “y” typed by a human, even when no anomaly is flagged: an order commits
// an amount, a delivery and Awa's word.
//
// Run, from the typescript/ folder:
//     npx tsx ch07/approve_orders.ts ../python/ch07/documents/order-01.jpg ../python/ch07/documents/order-02.jpg

import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import type { MessagesClient } from "../comptoir/client.ts";
import { imageBlock } from "../comptoir/documents.ts";
import { PurchaseOrder, checkOrder, extract } from "../comptoir/extraction.ts";
import { isMain } from "../comptoir/launch.ts";

export const REGISTER = "customer_data/orders.jsonl"; // customer data: outside Git

export function summary(order: PurchaseOrder): string {
  const lines = [`${order.customer ?? "?"} — ${order.neighborhood ?? "?"} — delivery: ${order.delivery_date_read ?? "?"}`];
  for (const line of order.lines) lines.push(`  ${line.quantity ?? "?"} × ${line.product ?? line.read_label}`);
  return lines.join("\n");
}

export async function approve(
  client: MessagesClient,
  path: string,
  ask: (question: string) => Promise<string> | string,
  register = REGISTER,
): Promise<Record<string, unknown> | null> {
  const result = await extract(client, [await imageBlock(path)], PurchaseOrder);
  console.log(`\n=== ${basename(path)}  (${result.cost})`);
  if (result.error || !result.data) {
    console.log(`Extraction failed: ${result.error} — to be entered by hand.`);
    return null;
  }
  const check = checkOrder(result.data);
  console.log(summary(result.data));
  console.log(`Amount calculated by the code: ${check.computedAmount ?? "?"} FCFA`);
  for (const anomaly of check.anomalies) console.log(`  ⚠ ${anomaly}`);
  if (check.computedAmount === null) {
    console.log("Amount impossible to calculate: correct the order with the customer before recording it.");
    return null;
  }
  if ((await ask("Record this order? [y/N] ")).trim().toLowerCase() !== "y") {
    console.log("Not recorded.");
    return null;
  }
  const order = {
    date: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    document: basename(path),
    request: result.requestId,
    order: result.data,
    amount_fcfa: check.computedAmount,
    accepted_anomalies: check.anomalies,
    approved_by_a_human: true,
  };
  mkdirSync(dirname(register), { recursive: true });
  appendFileSync(register, JSON.stringify(order) + "\n", "utf8");
  console.log("Recorded.");
  return order;
}

if (isMain(import.meta.url)) {
  const client = new Anthropic();
  const keyboard = createInterface({ input: process.stdin, output: process.stdout });
  for (const name of process.argv.slice(2)) await approve(client, name, (q) => keyboard.question(q));
  keyboard.close();
}
