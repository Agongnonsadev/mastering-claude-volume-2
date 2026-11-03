// What an MCP server announces (name, instructions, tools, resources, prompts), read by a client of each
// SDK, in the same shape: to compare the servers of chapters 15 and 16 with those of the Python version.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { execFileSync } from "node:child_process";
import { withoutReferences } from "../ch13/with_managed_agents.ts";
import { PYTHON } from "../comptoir/launch.ts";

/**
 * A schema as the TypeScript SDK publishes it, brought back to pydantic's: without “$schema”, without the
 * “additionalProperties: {}” (everything allowed, as with nothing), without the “properties: {}” it adds to a
 * table (an object with free keys), without the bounds of the integers nor the pattern Zod adds to dates;
 * pydantic's references, expanded.
 */
export function likePython(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(likePython);
  if (node === null || typeof node !== "object") return node;
  const o = { ...(node as Record<string, unknown>) };
  delete o.$schema;
  const empty = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v) && !Object.keys(v).length;
  if (empty(o.properties) && typeof o.additionalProperties === "object" && !empty(o.additionalProperties)) delete o.properties;
  if (empty(o.additionalProperties)) delete o.additionalProperties;
  if (o.type === "integer" && o.minimum === Number.MIN_SAFE_INTEGER && o.maximum === Number.MAX_SAFE_INTEGER) {
    delete o.minimum;
    delete o.maximum;
  }
  if (o.format === "date") delete o.pattern;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, likePython(v)]));
}

/**
 * The announcement read by the TypeScript client. The TypeScript SDK also announces, for each tool,
 * execution.taskSupport (“forbidden”): the Python version does not say it, which comes to the same for the
 * client. JSON.stringify removes the undefined fields.
 */
export async function typeScriptAnnouncement(c: Client): Promise<unknown> {
  return JSON.parse(
    JSON.stringify({
      server: c.getServerVersion(),
      instructions: c.getInstructions(),
      tools: (await c.listTools()).tools.map(({ execution: _, ...t }) => ({ ...t, inputSchema: likePython(t.inputSchema), outputSchema: likePython(t.outputSchema) })),
      resources: (await c.listResources()).resources,
      templates: (await c.listResourceTemplates()).resourceTemplates,
      prompts: (await c.listPrompts()).prompts.map((p) => ({ ...p, arguments: p.arguments ?? [] })),
    }),
  );
}

/** The announcement read by the Python SDK's client, in memory, on `server`: a Python expression, after `preamble`. */
export function pythonAnnouncement(python: string, preamble: string, server: string, env: NodeJS.ProcessEnv = {}): unknown {
  const script = `
import asyncio, json
from mcp import Client
${preamble}
async def main():
    async with Client(${server}) as c:
        d = lambda x: x.model_dump(mode="json", by_alias=True, exclude_none=True)
        print(json.dumps({"server": d(c.server_info), "instructions": c.instructions,
                          "tools": [d(t) for t in (await c.list_tools()).tools], "resources": [d(r) for r in (await c.list_resources()).resources],
                          "templates": [d(r) for r in (await c.list_resource_templates()).resource_templates],
                          "prompts": [d(p) for p in (await c.list_prompts()).prompts]}, ensure_ascii=False))
asyncio.run(main())`;
  const announcement = JSON.parse(execFileSync(python, ["-c", script], { cwd: PYTHON, encoding: "utf8", stdio: "pipe", env: { ...process.env, PYTHONIOENCODING: "utf-8", ...env } }));
  announcement.tools = announcement.tools.map((t: Record<string, unknown>) => ({
    ...t,
    inputSchema: likePython(withoutReferences(t.inputSchema as Record<string, unknown>)),
    outputSchema: likePython(withoutReferences(t.outputSchema as Record<string, unknown>)),
  }));
  return announcement;
}
