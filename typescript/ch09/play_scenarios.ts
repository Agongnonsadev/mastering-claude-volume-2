// Chapter 9: play the 10 order scenarios, and check by code what must be checked.
//
// Each scenario starts from a fresh shop, in memory. The code checks: the number of orders created, the
// tools called, the requests passed on to Awa, the absence of an invented product, and that no message
// from Claude announces a recorded order. The rest is reread: the script shows each exchange. The
// scenarios are those of the Python version (python/ch09/scenarios.json).
//
// Run, from the typescript/ folder:
//     npx tsx ch09/play_scenarios.ts --max-budget 0.5
//     npx tsx ch09/play_scenarios.ts --only discount quote

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Budget } from "../comptoir/budget.ts";
import { makeClient } from "../comptoir/call.ts";
import type { MessagesClient } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import { randomId } from "../comptoir/database.ts";
import { ComptoirError } from "../comptoir/errors.ts";
import { PYTHON, isMain, multipleValues } from "../comptoir/launch.ts";
import { ComptoirOrders } from "../comptoir/orders.ts";
import { Shop } from "../comptoir/shop.ts";

export interface Scenario {
  id: string;
  messages: string[];
  expected: {
    orders?: number;
    required_tools?: string[];
    forbidden_products?: string[];
    passed_on?: string | null;
    first_summary_replaced?: boolean;
  };
}

// Claude must never announce an order as done: only the code does, after the customer's code. The French
// forms too: the Comptoir answers in French a customer who writes in French.
const FORBIDDEN_ANNOUNCEMENT = new RegExp(
  "order\\s+(?:\\S+\\s+){0,3}?(?:is|has been|was)?\\s*(?:now\\s+)?(?:recorded|confirmed|validated|created|placed)|" +
    "commande\\s+(?:\\S+\\s+){0,3}?(?:est|a été|bien)?\\s*(?:enregistrée|confirmée|validée|créée)",
  "giu",
);
const NEGATION = /(?<![\p{L}\p{N}_])(?:not|n't|pas)(?![\p{L}\p{N}_])/iu;

export function load(): Scenario[] {
  return JSON.parse(readFileSync(join(PYTHON, "ch09", "scenarios.json"), "utf8")) as Scenario[];
}

export function replaceCodes(message: string, shop: Shop, conversation: string): string | null {
  const summaries = shop.summaries(conversation);
  if (message.includes("{code}") || message.includes("{first_code}")) {
    if (!summaries.length) return null;
    return message.replaceAll("{code}", summaries.at(-1)!.code).replaceAll("{first_code}", summaries[0]!.code);
  }
  return message;
}

/** “Your order is recorded”: yes. “It is not recorded yet”: no. */
export function announcesAnOrder(text: string): boolean {
  return [...text.matchAll(FORBIDDEN_ANNOUNCEMENT)].some((m) => !NEGATION.test(m[0]));
}

/** The gaps between what happened and what was expected. Empty list: passed. */
export function check(scenario: Scenario, shop: Shop, conversation: string, calls: string[], claudeTexts: string[]): string[] {
  const expected = scenario.expected;
  const gaps: string[] = [];
  const orders = shop.orders().filter((o) => o.conversation === conversation);
  if (orders.length !== (expected.orders ?? 0)) gaps.push(`${orders.length} order(s) created, ${expected.orders ?? 0} expected`);
  for (const tool of expected.required_tools ?? []) if (!calls.includes(tool)) gaps.push(`tool ${tool} never called`);
  const products = new Set(
    shop.summaries(conversation).flatMap((s) => (JSON.parse(s.lines) as { product: string }[]).map((l) => l.product)),
  );
  for (const forbidden of expected.forbidden_products ?? []) if (products.has(forbidden)) gaps.push(`invented product in a summary: ${forbidden}`);
  if ("passed_on" in expected) {
    const reasons = shop.requests().filter((r) => r.conversation === conversation).map((r) => r.reason);
    if (expected.passed_on === null && reasons.length) gaps.push(`passed on to Awa for no reason: ${JSON.stringify(reasons)}`);
    if (expected.passed_on && !reasons.includes(expected.passed_on)) gaps.push(`request “${expected.passed_on}” not passed on (passed on: ${JSON.stringify(reasons)})`);
  }
  if (expected.first_summary_replaced) {
    const summaries = shop.summaries(conversation);
    if (summaries.length < 2 || summaries[0]!.status !== "replaced") gaps.push("the first summary was not replaced");
  }
  for (const text of claudeTexts) {
    if (announcesAnOrder(text)) gaps.push(`Claude announces a recorded order: “${text.slice(0, 80)}”`);
  }
  return gaps;
}

export async function play(client: MessagesClient, scenario: Scenario, budget: Budget): Promise<string[]> {
  const shop = new Shop();
  const conversation = randomId();
  const comptoir = new ComptoirOrders(client, shop, budget, conversation);
  const calls: string[] = [];
  const claudeTexts: string[] = [];
  console.log(`\n=== ${scenario.id}`);
  for (const raw of scenario.messages) {
    const message = replaceCodes(raw, shop, conversation);
    if (message === null) return ["no summary: the confirmation code does not exist"];
    console.log(`Customer: ${message}`);
    let answer;
    try {
      answer = await comptoir.answer(message);
    } catch (error) {
      if (error instanceof ComptoirError) return [`error: ${error.diagnostic.code}`];
      throw error;
    }
    console.log(`Comptoir: ${answer.text}`);
    if (answer.turn) {
      calls.push(...answer.turn.execution.calls);
      claudeTexts.push(answer.turn.text); // the summary added by the code is not part of it
    }
  }
  return check(scenario, shop, conversation, calls, claudeTexts);
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    args: multipleValues(["only"]),
    options: {
      "max-budget": { type: "string", default: "0.5" }, // maximum spending of the series, in dollars
      only: { type: "string", multiple: true }, //          IDs of the scenarios to play
    },
  });
  // A budget dedicated to the series: daily and customer ceilings = max-budget.
  config.DAILY_BUDGET = config.CUSTOMER_DAILY_QUOTA = Number(args["max-budget"]);
  const budget = new Budget();
  const client = makeClient();
  const report = new Map<string, string[]>();
  for (const scenario of load()) {
    if (args.only?.length && !args.only.includes(scenario.id)) continue;
    report.set(scenario.id, await play(client, scenario, budget));
  }
  console.log(`\n=== Report (spent: $${budget.forDay().toFixed(4)})`);
  for (const [id, gaps] of report) console.log(`${gaps.length ? "FAILED" : "passed"}  ${id}${gaps.map((g) => `\n         - ${g}`).join("")}`);
}

if (isMain(import.meta.url)) await main();
