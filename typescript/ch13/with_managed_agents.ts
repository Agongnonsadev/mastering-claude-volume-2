// Chapter 13: the same agent, hosted by Anthropic with Claude Managed Agents (beta).
//
// Anthropic runs the agent loop; the workshop's tools stay on your side. They are custom tools: the session
// emits a call, this script runs it with the same functions as with the Tool Runner, and sends back the
// result. No built-in tool is turned on: neither bash, nor files, nor web. A session budget, in cents of a
// dollar, caps the spending; a timeout interrupts the session if it takes too long.
//
// At the end, the session, the agent and the environment are archived: their history remains readable, and
// nothing can run any more. Nothing is deleted.
//
// Run, from the typescript/ folder:  npx tsx ch13/with_managed_agents.ts --budget-cents 100

import Anthropic from "@anthropic-ai/sdk";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { parseArgs } from "node:util";
import { config } from "../comptoir/config.ts";
import { isMain } from "../comptoir/launch.ts";
import { repr } from "../comptoir/python.ts";
import { Context, Guard, INSTRUCTION, SYSTEM, type Tool, makeTools, settings } from "../comptoir/restock_agent.ts";
import { fixed } from "../comptoir/rounding.ts";
import { Trace } from "../comptoir/trace.ts";
import { Workshop, renderOrder } from "../comptoir/workshop.ts";
import { criteria } from "./criteria.ts";

/** Replaces the $ref with their definition: a custom tool schema all in one block. */
export function withoutReferences(schema: Record<string, unknown>): Record<string, unknown> {
  const definitions = (schema.$defs ?? {}) as Record<string, unknown>;
  const replace = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(replace);
    if (node !== null && typeof node === "object") {
      const object = node as Record<string, unknown>;
      if ("$ref" in object) return replace(structuredClone(definitions[String(object.$ref).split("/").at(-1)!]));
      return Object.fromEntries(Object.entries(object).filter(([k]) => k !== "$defs").map(([k, v]) => [k, replace(v)]));
    }
    return node;
  };
  return replace(schema) as Record<string, unknown>;
}

/** The workshop's tools as custom tools (without the memory tool, which has neither description nor schema). */
export const customTools = (tools: Tool[]): Record<string, unknown>[] =>
  tools.map((t) => {
    const o = t as Tool & { description: string; input_schema: Record<string, unknown> };
    return { type: "custom", name: o.name, description: o.description, input_schema: withoutReferences(o.input_schema) };
  });

/** A tool call from the session, run here: the text of the result, and whether it is an error. */
export async function execute(tools: Map<string, Tool>, name: string, toolArguments: Record<string, unknown>): Promise<[string, boolean]> {
  const t = tools.get(name);
  if (!t) throw new Error(repr(name)); // a KeyError in Python
  try {
    return [String(await t.run(toolArguments)), false];
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return [typeof error.content === "string" ? error.content : JSON.stringify(error.content), true];
  }
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      "budget-cents": { type: "string", default: "100" }, // hard ceiling of the session, in cents of a dollar
      timeout: { type: "string", default: "600" }, //        in seconds: beyond it, the session is interrupted
    },
  });
  const timeout = Number(args.timeout);
  const client = new Anthropic();
  const ctx = new Context(client, new Workshop(), new Guard(), new Trace());
  const tools = new Map((await makeTools(ctx, settings({ subagent: true }))).map((t) => [t.name, t]));
  const environment = await client.beta.environments.create({ name: "awa-workshop-ch13", config: { type: "cloud", networking: { type: "limited" } } });
  const agent = await client.beta.agents.create({
    name: "Délices d'Awa restocking (chapter 13)",
    model: config.MODEL,
    system: SYSTEM,
    tools: customTools([...tools.values()]) as unknown as Anthropic.Beta.AgentCreateParams["tools"],
  });
  const session = await client.beta.sessions.create({
    agent: agent.id,
    environment_id: environment.id,
    title: "Order of October 19, 2026",
    budget: { type: "limit", max_list_cost: { amount: args["budget-cents"], currency: "USD" } },
  });
  console.log(`Environment ${environment.id}, agent ${agent.id} (version ${agent.version}), session ${session.id}`);

  const start = performance.now();
  const texts: string[] = [];
  const calls: string[] = [];
  let end: string | null = null;
  try {
    // The stream only delivers the events emitted after it is opened: it is opened first.
    const stream = await client.beta.sessions.events.stream(session.id);
    await client.beta.sessions.events.send(session.id, { events: [{ type: "user.message", content: [{ type: "text", text: INSTRUCTION }] }] });
    for await (const event of stream) {
      if ((performance.now() - start) / 1000 > timeout) {
        await client.beta.sessions.events.send(session.id, { events: [{ type: "user.interrupt" }] });
        end = "timeout exceeded: session interrupted";
        break;
      }
      if (event.type === "agent.custom_tool_use") {
        calls.push(event.name);
        const [text, error] = await execute(tools, event.name, { ...(event.input as Record<string, unknown>) });
        await client.beta.sessions.events.send(session.id, {
          events: [{ type: "user.custom_tool_result", custom_tool_use_id: event.id, content: [{ type: "text", text }], is_error: error }],
        });
      } else if (event.type === "agent.message") {
        for (const b of event.content) if (b.type === "text") texts.push(b.text);
      } else if (event.type === "session.status_idle") {
        const reason = event.stop_reason ? event.stop_reason.type : null;
        if (reason === "end_turn" || reason === "budget_reached") {
          end = reason;
          break;
        }
        // requires_action: the results have already gone, the session restarts on its own.
      }
    }
  } finally {
    const duration = (performance.now() - start) / 1000;
    const reread = await client.beta.sessions.retrieve(session.id);
    console.log(`\nEnd: ${end ?? "None"}; ${fixed(duration, 1)} s; tool calls: ${repr(calls)}`);
    console.log(`Usage of the session: ${JSON.stringify(reread.usage)}`);
    console.log(`Of which subagent (called by our code): $${fixed(ctx.subagentCost, 4)}`);
    const archives: [string, () => Promise<unknown>][] = [
      ["session", () => client.beta.sessions.archive(session.id)],
      ["agent", () => client.beta.agents.archive(agent.id)],
      ["environment", () => client.beta.environments.archive(environment.id)],
    ];
    for (const [name, archive] of archives) {
      try {
        await archive();
        console.log(`${name} archived`);
      } catch (error) {
        if (!(error instanceof Anthropic.APIError)) throw error;
        console.log(`${name} NOT archived: ${error.message}`);
      }
    }
  }

  console.log("\nThe agent's summary:\n" + texts.slice(-1).join("\n"));
  console.log("\n" + (ctx.order ? renderOrder(ctx.order) : "No order proposed."));
  console.log("\nCriteria: " + Object.entries(criteria(ctx.order)).map(([k, v]) => `${k} ${v ? "yes" : "NO"}`).join(", "));
}

if (isMain(import.meta.url)) await main();
