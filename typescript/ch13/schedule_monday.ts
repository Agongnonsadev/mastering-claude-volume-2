// Chapter 13: the restocking agent, started every Monday at 7 a.m. by Managed Agents (beta).
//
// By default, this script does not call the API: it shows the request it would send. With --create, it
// creates a scheduled deployment, which will start a session every Monday, with its budget, until you
// archive it (npx tsx ch13/schedule_monday.ts --archive ID). Each session costs money.
//
// Warning: the chapter's agent has custom tools, run by your code. A scheduled session that calls such a
// tool goes into waiting (requires_action) as long as nobody answers. A schedule therefore requires a
// program that listens to the events (webhooks), or tools that run on Anthropic's side: an MCP server
// (chapters 14 to 16).
//
// Run, from the typescript/ folder:
//     npx tsx ch13/schedule_monday.ts --agent AGENT_ID --environment ENV_ID             (shows only)
//     npx tsx ch13/schedule_monday.ts --agent AGENT_ID --environment ENV_ID --create    (creates the deployment)

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import { isMain } from "../comptoir/launch.ts";
import { pythonJson } from "../comptoir/python.ts";
import { INSTRUCTION } from "../comptoir/restock_agent.ts";

export const MONDAY_7AM = { type: "cron", expression: "0 7 * * 1", timezone: "Africa/Porto-Novo" } as const;

export function request(agent: string, environment: string, budgetCents: number): Anthropic.Beta.DeploymentCreateParams {
  return {
    name: "Monday restocking",
    agent,
    environment_id: environment,
    initial_events: [{ type: "user.message", content: [{ type: "text", text: INSTRUCTION }] }],
    schedule: MONDAY_7AM,
    // Copied onto each session started: it caps each Monday, not the total.
    budget: { type: "limit", max_list_cost: { amount: String(budgetCents), currency: "USD" } },
  };
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      agent: { type: "string" },
      environment: { type: "string" },
      "budget-cents": { type: "string", default: "50" },
      create: { type: "boolean", default: false }, // really creates the deployment (paid every Monday)
      archive: { type: "string" }, //                 archives a deployment: no more starts
    },
  });
  if (args.archive) {
    await new Anthropic().beta.deployments.archive(args.archive);
    console.log(`Deployment ${args.archive} archived: it will start nothing any more.`);
    return;
  }
  if (!(args.agent && args.environment)) {
    console.error("error: --agent and --environment are required");
    process.exit(2);
  }
  const body = request(args.agent, args.environment, Number.parseInt(args["budget-cents"], 10));
  if (!args.create) {
    console.log("Request that would be sent (nothing is created without --create):");
    console.log(pythonJson(body, 2));
    return;
  }
  const deployment = await new Anthropic().beta.deployments.create(body);
  console.log(`Deployment ${deployment.id} created; next starts: ${deployment.schedule?.upcoming_runs_at}`);
  console.log(`To stop it: npx tsx ch13/schedule_monday.ts --archive ${deployment.id}`);
}

if (isMain(import.meta.url)) await main();
