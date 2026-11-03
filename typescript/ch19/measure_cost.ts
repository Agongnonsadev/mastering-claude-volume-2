// Chapter 19: the cost per conversation of the Comptoir online, and each lever measured apart.
//
// From the typescript/ folder:
//     npx tsx ch19/measure_cost.ts --estimate                                       (free)
//     npx tsx ch19/measure_cost.ts --variant shipped --trials 3 --max-budget 0.2    (PAID, capped)
//     npx tsx ch19/measure_cost.ts --variant effort-low --trials 3 --max-budget 0.2
//     npx tsx ch19/measure_cost.ts --variant no-cache --trials 3 --max-budget 0.3
//
// Eight typical conversations (python/ch19/conversations.json, shared by the two versions), from the simple
// “do you deliver to…?” to the order confirmed by its code, go through the online service (comptoir/service.ts):
// the conversation kept in the database, the budget per message, the routed Comptoir. “YES {code}” is replaced
// by the code of the last summary, read in the shop, as the customer would do.
//
// Each trial starts from a fresh shop at a fixed time (the harness of chapter 17). The conversations follow
// one another, as in a day: the first one writes the one-hour cache, the following ones read it.
// A recorder keeps each call: model, input, cache and output tokens, cost, duration.
// A variant changes only one thing compared with the shipped version.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { RoutingOptions } from "../comptoir/routing.ts";
import { fixed, round } from "../comptoir/rounding.ts";
import type { Shop } from "../comptoir/shop.ts";
import { Budget } from "../comptoir/budget.ts";
import { Conversations } from "../comptoir/conversations.ts";
import { PYTHON, ROOT, isMain } from "../comptoir/launch.ts";
import { mean, pythonJson, sum } from "../comptoir/python.ts";
import { ComptoirService } from "../comptoir/service.ts";
import { Recorder, environment } from "../ch17/harness.ts";
import { timestamp } from "../ch17/suite.ts";

export const RESULTS = join(ROOT, "ch19", "results", "costs");
export const VARIANTS: Record<string, RoutingOptions> = {
  shipped: {}, //                                Haiku 5.5, default effort (medium), one-hour cache
  "effort-low": { comptoirEffort: "low" }, //    the Comptoir's effort at low
  "no-cache": { cache: false }, //               without the cache, to see what it brings
};
/** A variant's settings, with the Python version's names (for the results file). */
const PYTHON_SETTINGS: Record<string, Record<string, unknown>> = { shipped: {}, "effort-low": { comptoir_effort: "low" }, "no-cache": { cache: false } };
const ASSUMED_COST_PER_MESSAGE = 0.003; // $: generous
const TOKEN_KEYS = ["input", "cache_write", "cache_read", "output"] as const;

/** A conversation played, with the Python version's field names. */
export interface Conversation {
  variant: string;
  id: string;
  trial: number;
  messages: number;
  categories: string[];
  cost_dollars: number;
  calls: number;
  tokens: Partial<Record<(typeof TOKEN_KEYS)[number], number>>;
  durations_ms: number[];
  orders: number;
  errors: string[];
}

export const makeConversation = (variant: string, id: string, trial: number, fields: Partial<Conversation> = {}): Conversation => ({
  variant, id, trial, messages: 0, categories: [], cost_dollars: 0, calls: 0, tokens: {}, durations_ms: [], orders: 0, errors: [], ...fields,
});

export interface Scenario {
  id: string;
  messages: string[];
}

export const loadConversations = (): Scenario[] => JSON.parse(readFileSync(join(PYTHON, "ch19", "conversations.json"), "utf8")) as Scenario[];

export function pendingCode(shop: Shop, conversation: string): string | null {
  const pending = shop.summaries(conversation).filter((s) => s.status === "pending").map((s) => s.code);
  return pending.at(-1) ?? null;
}

export async function play(service: ComptoirService, recorder: Recorder, scenario: Scenario, variant: string, trial: number): Promise<Conversation> {
  const result = makeConversation(variant, scenario.id, trial);
  const before = recorder.calls.length;
  const [conversation] = service.open(null);
  for (let message of scenario.messages) {
    if (message.includes("{code}")) {
      const code = pendingCode(service.shop, conversation);
      if (code === null) {
        result.errors.push("no summary to confirm");
        continue;
      }
      message = message.replaceAll("{code}", code);
    }
    const turn = await service.answer(conversation, message, "measurement", "measurement");
    result.messages += 1;
    result.categories.push(turn.category);
    result.cost_dollars += turn.costDollars;
    result.durations_ms.push(turn.durationMs);
    if (turn.error) result.errors.push(turn.error);
  }
  const calls = recorder.calls.slice(before);
  result.calls = calls.length;
  result.tokens = Object.fromEntries(TOKEN_KEYS.map((key) => [key, calls.reduce((s, c) => s + c.tokens[key], 0)]));
  result.orders = service.shop.orders().filter((o) => o.conversation === conversation).length;
  result.cost_dollars = round(result.cost_dollars, 6);
  return result;
}

export function summarize(conversations: Conversation[]): Record<string, unknown> {
  const costs = conversations.map((c) => c.cost_dollars);
  const messages = conversations.reduce((s, c) => s + c.messages, 0);
  const durations = conversations.flatMap((c) => c.durations_ms).sort((a, b) => a - b);
  return {
    conversations: conversations.length,
    messages,
    total_cost: round(sum(costs), 4),
    average_cost_per_conversation: costs.length ? round(mean(costs), 5) : null,
    average_cost_per_message: messages ? round(sum(costs) / messages, 5) : null,
    calls_per_message: messages ? round(conversations.reduce((s, c) => s + c.calls, 0) / messages, 2) : null,
    tokens: Object.fromEntries(TOKEN_KEYS.map((key) => [key, conversations.reduce((s, c) => s + (c.tokens[key] ?? 0), 0)])),
    median_latency_s: durations.length ? round(durations[Math.floor(durations.length / 2)]! / 1000, 1) : null,
    latency_p90_s: durations.length ? round(durations[Math.min(durations.length - 1, round(0.9 * (durations.length - 1)))]! / 1000, 1) : null,
    orders_created: conversations.reduce((s, c) => s + c.orders, 0),
    errors: conversations.flatMap((c) => c.errors),
  };
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      variant: { type: "string", default: "shipped" },
      trials: { type: "string", default: "3" },
      "max-budget": { type: "string", default: "0.2" },
      estimate: { type: "boolean", default: false },
    },
  });
  if (!(args.variant in VARIANTS)) throw new Error(`--variant: ${args.variant}? Choices: ${Object.keys(VARIANTS).sort().join(", ")}.`);
  const trials = Number(args.trials);
  const maxBudget = Number(args["max-budget"]);
  const scenarios = loadConversations();
  const count = scenarios.reduce((s, x) => s + x.messages.length, 0);
  console.log(`${scenarios.length} conversations, ${count} messages, ${trials} trial(s); generous estimate: $${fixed(count * trials * ASSUMED_COST_PER_MESSAGE, 2)}`);
  if (args.estimate) return;

  const { makeClient } = await import("../comptoir/call.ts");
  const { loadKnowledge } = await import("../comptoir/knowledge.ts");
  const client = makeClient();
  const knowledge = loadKnowledge();
  const results: Conversation[] = [];
  let spent = 0;
  for (let trial = 1; trial <= trials; trial++) {
    const recorder = new Recorder(client);
    const service = new ComptoirService(recorder, environment(), new Budget(":memory:"), new Conversations(), knowledge, VARIANTS[args.variant]);
    for (const scenario of scenarios) {
      if (spent >= maxBudget) {
        console.log(`Stop: ceiling of $${maxBudget} reached.`);
        break;
      }
      const c = await play(service, recorder, scenario, args.variant, trial);
      spent += c.cost_dollars;
      results.push(c);
      console.log(`  ${args.variant.padEnd(10)} ${c.id.padEnd(22)} ${trial}  $${fixed(c.cost_dollars, 5)}  ${String(c.calls).padStart(2)} calls  ${c.categories.join(" > ")}  ${c.errors.join("; ")}`);
    }
  }
  const summary = summarize(results);
  mkdirSync(RESULTS, { recursive: true });
  const output = join(RESULTS, `${timestamp()}-${args.variant}.json`);
  writeFileSync(output, pythonJson({ variant: args.variant, settings: PYTHON_SETTINGS[args.variant], summary, conversations: results }, 1), "utf8");
  console.log(pythonJson(summary, 1));
  console.log(`→ ${output}`);
}

if (isMain(import.meta.url)) await main();
