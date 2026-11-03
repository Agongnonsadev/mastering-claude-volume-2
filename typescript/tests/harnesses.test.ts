// The same agent in two other harnesses, the Claude Agent SDK and Managed Agents, and its schedule: no call
// (python/tests/test_harnesses.py), and the same definitions as the Python version. The workshop's MCP server
// is questioned by a real MCP client, in memory, as Claude Code would do.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MONDAY_7AM, request } from "../ch13/schedule_monday.ts";
import { READING, guard, logAction, options, workshopServer } from "../ch13/with_agent_sdk.ts";
import { customTools, execute, withoutReferences } from "../ch13/with_managed_agents.ts";
import { PYTHON } from "../comptoir/launch.ts";
import { Context, Guard, makeTools, settings } from "../comptoir/restock_agent.ts";
import { Trace } from "../comptoir/trace.ts";
import { Workshop } from "../comptoir/workshop.ts";
import { logLines, temporaryLog } from "./fake_clients.ts";

// The tools record their steps: in a temporary log, never in the Comptoir's.
let log: string;
beforeEach(() => {
  log = temporaryLog();
});

// --- The Claude Agent SDK ------------------------------------------------------------------------

async function decision(input: Record<string, unknown>): Promise<string | undefined> {
  const output = (await guard(input as never, "toolu_1", { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
  return output.hookSpecificOutput?.permissionDecision;
}

test("the hook reserves message reading for the subagent", async () => {
  assert.equal(await decision({ tool_name: READING }), "deny"); //                                       the main agent
  assert.equal(await decision({ tool_name: READING, agent_id: "a1", agent_type: "reader" }), undefined); // the subagent
  assert.equal(await decision({ tool_name: "Bash" }), "deny");
  assert.equal(await decision({ tool_name: "Agent" }), undefined);
  assert.equal(await decision({ tool_name: "mcp__workshop__read_stock" }), undefined);
});

test("the after hook records who did what, without the data", async () => {
  await logAction({ tool_name: READING, agent_type: "reader", tool_input: { secret: "x" } } as never, "toolu_1", { signal: new AbortController().signal });
  await logAction({ tool_name: "Agent" } as never, "toolu_2", { signal: new AbortController().signal });
  assert.deepEqual(logLines(log).map((l) => [l.event, l.tool, l.by, "tool_input" in l]), [["action", READING, "reader", false], ["action", "Agent", "main agent", false]]);
});

test("the SDK options open nothing more", async () => {
  const folder = mkdtempSync(join(tmpdir(), "agent-sdk-"));
  const o = await options(new Context(null, new Workshop(), new Guard(), new Trace()), 0.6, folder);
  assert.deepEqual(o.tools, ["Agent"]);
  assert.ok(o.permissionMode === "dontAsk" && o.settingSources!.length === 0);
  assert.deepEqual(o.agents!.reader!.tools, [READING]);
  assert.ok(o.agents!.reader!.model === "claude-haiku-5-5" && o.maxBudgetUsd === 0.6);
  assert.ok(o.env!.CLAUDE_CONFIG_DIR!.startsWith(folder));
  // Like the Python SDK: the process's environment, without CLAUDECODE, and the variables given.
  assert.ok(!("CLAUDECODE" in o.env!) && o.env!.PATH === (process.env.PATH ?? o.env!.PATH));
});

/** The workshop's MCP server, linked to a real MCP client by an in-memory transport. */
async function serverClient(): Promise<Client> {
  const server = await workshopServer(new Context(null, new Workshop(), new Guard(), new Trace()));
  const [side, other] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(side);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(other);
  return client;
}

test("the workshop's MCP server: the seven tools, their outputs and their errors", async () => {
  const client = await serverClient();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["read_sales", "read_stock", "read_events", "read_suppliers", "compute_needs", "read_supplier_messages", "propose_purchase_order"]);
  const byName = new Map((await makeTools(new Context(null, new Workshop(), new Guard(), new Trace()), settings({ subagent: false }))).map((t) => [t.name, t]));
  const stock = (await client.callTool({ name: "read_stock", arguments: {} })) as { content: { text: string }[]; isError?: boolean };
  assert.equal(stock.content[0]!.text, await byName.get("read_stock")!.run({})); // the same text as with the Tool Runner
  const error = (await client.callTool({ name: "compute_needs", arguments: { production: { "Baobab juice": 3 } } })) as { content: { text: string }[]; isError?: boolean };
  assert.ok(error.isError && error.content[0]!.text.includes("unknown products"));
  await client.close();
});

const tools = async () => makeTools(new Context(null, new Workshop(), new Guard(), new Trace()), settings());

test("the custom tools have a schema in one block", async () => {
  const propose = customTools(await tools()).find((t) => t.name === "propose_purchase_order")!;
  assert.ok(propose.type === "custom" && !JSON.stringify(propose.input_schema).includes("$defs"));
  const schema = propose.input_schema as { properties: { lines: { items: { properties: { desired_delivery: { type: string } } } } } };
  assert.equal(schema.properties.lines.items.properties.desired_delivery.type, "string");
  const simple = { type: "object", properties: { a: { type: "string" } } };
  assert.deepEqual(withoutReferences(simple), simple);
});

test("a tool error comes back as an error", async () => {
  const byName = new Map((await tools()).map((t) => [t.name, t]));
  let [text, error] = await execute(byName, "compute_needs", { production: { "Baobab juice": 3 } });
  assert.ok(error && text.includes("unknown products"));
  [text, error] = await execute(byName, "read_stock", {});
  assert.ok(!error && text.includes("finished_products"));
});

test("the Monday schedule calls nothing by default", () => {
  const body = request("agent_x", "env_x", 50);
  assert.deepEqual(MONDAY_7AM, { type: "cron", expression: "0 7 * * 1", timezone: "Africa/Porto-Novo" });
  assert.deepEqual(body.budget!.max_list_cost, { amount: "50", currency: "USD" });
  assert.equal(body.initial_events![0]!.type, "user.message");
});

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

test("the same custom tools and the same schedule as the Python version", { skip: PYTHON_VENV ? false : "Python environment missing" }, async () => {
  const script = `
import json
from ch13.with_managed_agents import custom_tools
from ch13.schedule_monday import request
from comptoir.restock_agent import Context, Guard, Settings, make_tools
from comptoir.trace import Trace
from comptoir.workshop import Workshop
tools = make_tools(Context(None, Workshop(), Guard(), Trace()), Settings())
print(json.dumps({"tools": custom_tools(tools), "schedule": request("agent_x", "env_x", 50)}, ensure_ascii=False))`;
  const python = JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script], { cwd: PYTHON, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }));
  assert.deepEqual({ tools: customTools(await tools()), schedule: request("agent_x", "env_x", 50) }, python);
});

const INPUTS = [
  { tool_name: READING },
  { tool_name: READING, agent_id: "a1", agent_type: "reader" },
  { tool_name: "Bash" },
  { tool_name: "Bash", agent_id: "a1" },
  { tool_name: "Agent" },
  { tool_name: "mcp__workshop__read_stock" },
  { tool_name: "mcp__other__read_stock" },
  { tool_name: READING, agent_id: "" },
];

/**
 * A schema as Zod returns it, brought back to the Python version's: the TypeScript SDK adds “$schema”, bounds
 * to the integers, “properties: {}” to a table and “additionalProperties: {}” (everything allowed, as with
 * nothing) to an object, and removes the top “additionalProperties: false”. The rest must be identical.
 */
function likePython(node: unknown, top = true): unknown {
  if (Array.isArray(node)) return node.map((n) => likePython(n, false));
  if (node === null || typeof node !== "object") return node;
  const o = { ...(node as Record<string, unknown>) };
  delete o.$schema;
  if (top) delete o.additionalProperties;
  if (o.type === "integer" && o.minimum === Number.MIN_SAFE_INTEGER && o.maximum === Number.MAX_SAFE_INTEGER) {
    delete o.minimum;
    delete o.maximum;
  }
  if (typeof o.additionalProperties === "object" && o.additionalProperties !== null && !Object.keys(o.additionalProperties).length) delete o.additionalProperties;
  if (o.additionalProperties && typeof o.properties === "object" && !Object.keys(o.properties as object).length) delete o.properties;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, likePython(v, false)]));
}

test("the same hook decisions and the same MCP tools as the Python version", { skip: PYTHON_VENV ? false : "Python environment missing" }, async () => {
  const script = `
import asyncio, json, sys
from ch13.with_agent_sdk import guard
from ch13.with_managed_agents import without_references
from comptoir.restock_agent import Context, Guard, Settings, make_tools
from comptoir.trace import Trace
from comptoir.workshop import Workshop
inputs = json.load(sys.stdin)
tools = make_tools(Context(None, Workshop(), Guard(), Trace()), Settings(subagent=False))
print(json.dumps({"decisions": [asyncio.run(guard(i, "toolu_1", None)) for i in inputs],
                  "tools": [[t.name, t.description, without_references(t.input_schema)] for t in tools]}, ensure_ascii=False))`;
  const python = JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script], { cwd: PYTHON, input: JSON.stringify(INPUTS), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }),
  ) as { decisions: unknown[]; tools: [string, string, Record<string, unknown>][] };
  const decisions = [];
  for (const i of INPUTS) decisions.push(await guard(i as never, "toolu_1", { signal: new AbortController().signal }));
  assert.deepEqual(decisions, python.decisions);
  const client = await serverClient();
  const { tools: listed } = await client.listTools();
  await client.close();
  assert.deepEqual(
    listed.map((t) => [t.name, t.description, likePython(t.inputSchema)]),
    python.tools.map(([name, description, schema]) => [name, description, likePython(schema)]),
  );
});
