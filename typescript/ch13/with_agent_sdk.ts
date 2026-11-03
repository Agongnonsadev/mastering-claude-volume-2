// Chapter 13: the same agent, built with the Claude Agent SDK, Claude Code's engine as a library.
//
// - the workshop's tools, the same functions as with the Tool Runner, become an MCP server that runs in
//   this process;
// - no built-in tool of Claude Code, except Agent, which entrusts a task to a subagent;
// - a “reader” subagent, on Claude Haiku 5.5, is the only one that can read the suppliers' messages: a
//   PreToolUse hook checks it at each call, through the code;
// - a PostToolUse hook records each action in the log;
// - none of the user's settings is loaded (settingSources: []), Claude Code's configuration is fresh
//   (CLAUDE_CONFIG_DIR), and the agent works in an empty folder.
//
// The TypeScript SDK (@anthropic-ai/claude-agent-sdk) describes the tools with a Zod schema: it is drawn
// from the same JSON schema as the Tool Runner's (z.fromJSONSchema). Its env option replaces the
// environment of the subprocess, whereas the Python SDK's adds to it: process.env is therefore copied into
// it, without CLAUDECODE, as the Python SDK does.
//
// Run, from the typescript/ folder:  npx tsx ch13/with_agent_sdk.ts --max-budget 0.60

import {
  type HookCallback,
  type Options,
  type SDKResultMessage,
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { config } from "../comptoir/config.ts";
import { isMain } from "../comptoir/launch.ts";
import { logEvent } from "../comptoir/log.ts";
import { repr } from "../comptoir/python.ts";
import { Context, Guard, INSTRUCTION, READER, SYSTEM, type Tool, makeTools, settings } from "../comptoir/restock_agent.ts";
import { fixed } from "../comptoir/rounding.ts";
import { Trace } from "../comptoir/trace.ts";
import { Workshop, renderOrder } from "../comptoir/workshop.ts";
import { criteria } from "./criteria.ts";
import { withoutReferences } from "./with_managed_agents.ts";

export const SERVER = "workshop";
export const READING = `mcp__${SERVER}__read_supplier_messages`;

/** The Tool Runner's tools, wrapped for the SDK: same name, same description, same schema. */
export async function workshopServer(ctx: Context) {
  const tools = (await makeTools(ctx, settings({ subagent: false }))).map((t) => {
    // Direct reading: it is the subagent that reads.
    const o = t as Tool & { description: string; input_schema: Record<string, unknown> };
    const shape = (z.fromJSONSchema(withoutReferences(o.input_schema)) as z.ZodObject).shape;
    return tool(o.name, o.description, shape, async (args) => {
      try {
        return { content: [{ type: "text" as const, text: String(await o.run(args)) }] };
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        return { content: [{ type: "text" as const, text: String(error.content) }], isError: true };
      }
    });
  });
  return createSdkMcpServer({ name: SERVER, version: "1.0.0", tools });
}

/** PreToolUse: the rule is in the code, not in the prompt. Subagents have an agent_id. */
export const guard: HookCallback = async (input) => {
  const { tool_name: name, agent_id: agent } = input as { tool_name: string; agent_id?: string };
  let refusal: string | null = null;
  if (name !== "Agent" && !name.startsWith(`mcp__${SERVER}__`)) refusal = "only the workshop's tools are allowed";
  else if (name === READING && !agent) refusal = "reading the messages is reserved for the reader subagent: hand it your question";
  if (refusal) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refusal } };
  return {};
};

/** PostToolUse: the log of actions, without the data (only who did what). */
export const logAction: HookCallback = async (input) => {
  const { tool_name: toolName, agent_type: type } = input as { tool_name: string; agent_type?: string };
  logEvent("action", { tool: toolName, by: type || "main agent" });
  return {};
};

/** The Python SDK's environment: that of the process, without CLAUDECODE, with the variables given. */
function environment(additions: Record<string, string>): Record<string, string> {
  const inherited = Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "CLAUDECODE" && e[1] !== undefined);
  return { ...Object.fromEntries(inherited), ...additions };
}

export async function options(ctx: Context, maxBudget: number, folder: string): Promise<Options> {
  const workshopTools = ["read_sales", "read_stock", "read_events", "read_suppliers", "compute_needs", "read_supplier_messages", "propose_purchase_order"].map(
    (name) => `mcp__${SERVER}__${name}`,
  );
  return {
    model: config.MODEL,
    systemPrompt: SYSTEM + "\n\nTo know the suppliers' messages, hand your question to the “reader” subagent, with the Agent tool.",
    mcpServers: { [SERVER]: await workshopServer(ctx) },
    tools: ["Agent"], //                  no built-in tool, except delegating to a subagent
    allowedTools: ["Agent", ...workshopTools],
    permissionMode: "dontAsk", //         what is not allowed is refused, without a question
    agents: {
      reader: {
        description: "Reads the suppliers' WhatsApp messages and answers a precise question, citing the dates and the suppliers.",
        prompt: READER + "\n\nRead the messages with the read_supplier_messages tool.",
        tools: [READING],
        model: config.AUXILIARY_MODEL,
      },
    },
    hooks: { PreToolUse: [{ hooks: [guard] }], PostToolUse: [{ hooks: [logAction] }] },
    maxTurns: 20,
    maxBudgetUsd: maxBudget, //           an estimate on the client side, which can be slightly exceeded
    settingSources: [], //                neither your settings, nor your CLAUDE.md, nor your Skills
    cwd: folder,
    env: environment({ CLAUDE_CONFIG_DIR: join(folder, ".config") }),
  };
}

export async function runWithTheSdk(maxBudget: number): Promise<[SDKResultMessage | null, Context, string[]]> {
  const ctx = new Context(null, new Workshop(), new Guard(), new Trace());
  const calls: string[] = [];
  const folder = mkdtempSync(join(tmpdir(), "agent-sdk-"));
  try {
    let result: SDKResultMessage | null = null;
    for await (const message of query({ prompt: INSTRUCTION, options: await options(ctx, maxBudget, folder) })) {
      if (message.type === "assistant") calls.push(...message.message.content.filter((b) => b.type === "tool_use").map((b) => (b as { name: string }).name));
      else if (message.type === "result") result = message;
    }
    return [result, ctx, calls];
  } finally {
    rmSync(folder, { recursive: true, force: true }); // the working folder, and the fresh configuration it contains
  }
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: { "max-budget": { type: "string", default: "0.60" } } });
  const start = performance.now();
  const [result, ctx, calls] = await runWithTheSdk(Number(args["max-budget"]));
  console.log(`Tool calls of the main agent: ${repr(calls)}`);
  console.log(ctx.trace.show());
  if (result) {
    console.log(`\nEnd: ${result.subtype}; ${result.num_turns} turns; $${result.total_cost_usd} (SDK's estimate); ${fixed(result.duration_ms / 1000, 1)} s`);
    console.log(`Cost per model: ${repr(result.modelUsage ?? null)}`);
    console.log("\nThe agent's summary:\n" + (result.subtype === "success" ? result.result : ""));
  }
  console.log(`\nTotal duration: ${fixed((performance.now() - start) / 1000, 1)} s`);
  console.log("\n" + (ctx.order ? renderOrder(ctx.order) : "No order proposed."));
  console.log("\nCriteria: " + Object.entries(criteria(ctx.order)).map(([k, v]) => `${k} ${v ? "yes" : "NO"}`).join(", "));
}

if (isMain(import.meta.url)) await main();
