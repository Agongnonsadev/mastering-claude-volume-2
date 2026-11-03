// Chapter 13: one session of the restocking agent, with its trace, its order and its criteria.
//
// Run, from the typescript/ folder:  npx tsx ch13/restock.ts
// Variants:  --no-subagent   --model claude-haiku-5-5   --memory workshop_memory
//            --task-budget 40000   --clear-after 8000   --compact-after-turn 2
//            --max-turns 3   --max-budget 0.05

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { config } from "../comptoir/config.ts";
import { isMain } from "../comptoir/launch.ts";
import { repr } from "../comptoir/python.ts";
import { type AgentClient, Guard, type Settings, run, settings } from "../comptoir/restock_agent.ts";
import { fixed } from "../comptoir/rounding.ts";
import { Workshop, renderOrder } from "../comptoir/workshop.ts";
import { criteria } from "./criteria.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** The options shared by the scripts that run the agent. */
export const OPTIONS = {
  model: { type: "string", default: config.MODEL },
  effort: { type: "string" },
  "no-subagent": { type: "boolean", default: false }, // the agent reads all the messages itself
  memory: { type: "string" }, //                       folder of the agent's memory, kept from one week to the next
  "task-budget": { type: "string" }, //                 in tokens, 20,000 at least (beta)
  "clear-after": { type: "string" }, //                 clears the old tool results beyond N tokens
  "compact-after-turn": { type: "string" }, //          summarizes the session after this turn (beta)
  "max-turns": { type: "string", default: "20" },
  "max-budget": { type: "string", default: "0.50" }, // in dollars, for the session
  timeout: { type: "string", default: "300" }, //       in seconds, for the session
} as const;

type Values = { [K in keyof typeof OPTIONS]?: string | boolean };

export function settingsAndGuard(args: Values): [Settings, Guard] {
  const integer = (v: unknown): number | null => (v === undefined ? null : Number.parseInt(String(v), 10));
  if (args.effort !== undefined && !EFFORTS.includes(String(args.effort))) throw new Error(`--effort: ${EFFORTS.join(", ")}.`);
  return [
    settings({
      model: String(args.model),
      effort: (args.effort as Settings["effort"]) ?? null,
      subagent: !args["no-subagent"],
      memory: (args.memory as string | undefined) ?? null,
      taskBudget: integer(args["task-budget"]),
      clearResultsAfter: integer(args["clear-after"]),
      compactAfterTurn: integer(args["compact-after-turn"]),
    }),
    new Guard({ maxTurns: Number(args["max-turns"]), budgetDollars: Number(args["max-budget"]), timeoutS: Number(args.timeout) }),
  ];
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: { ...OPTIONS, orders: { type: "string" } } }); // orders: the file of the proposed orders
  const [s, guard] = settingsAndGuard(args);
  if (s.memory) mkdirSync(s.memory, { recursive: true });
  const result = await run(new Anthropic() as unknown as AgentClient, new Workshop({ orders: args.orders ?? null }), s, guard);
  console.log(result.trace.show());
  console.log(
    `\nStop: ${result.stop || "finished by the agent"}; ${result.turns} turns; $${fixed(result.spent, 4)} ` +
      `(subagent $${fixed(result.subagentCost, 4)}); ${fixed(result.durationS, 1)} s; ` +
      `largest context: ${result.contextPeak} tokens`,
  );
  if (result.clearings.length) console.log(`Clearings: ${repr(result.clearings)}`);
  console.log("\n" + (result.order ? renderOrder(result.order) : "No order proposed."));
  console.log("\nThe agent's summary:\n" + result.text);
  console.log("\nCriteria: " + Object.entries(criteria(result.order, s.memory !== null)).map(([k, v]) => `${k} ${v ? "yes" : "NO"}`).join(", "));
}

if (isMain(import.meta.url)) await main();
