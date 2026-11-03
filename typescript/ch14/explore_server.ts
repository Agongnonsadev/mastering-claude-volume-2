// Chapter 14: look at an MCP server before entrusting it to Claude. No call to the Claude API.
//
// Run, from the typescript/ folder:
//     npx tsx ch14/explore_server.ts orders                     # DBHub on the exploration copy
//     npx tsx ch14/explore_server.ts orders --try-to-write
//     npx tsx ch14/explore_server.ts everything                 # sample tools, resources and prompts
//     npx tsx ch14/explore_server.ts doc                        # Anthropic's documentation
//
// The script behaves like an MCP client: it connects, shows the negotiated protocol version, the server's
// instructions and the full description of each tool, resource and prompt. That is the text Claude will
// read as instructions: it must be read before Claude does.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { AFTER } from "../comptoir/guard.ts";
import { isMain } from "../comptoir/launch.ts";
import { repr, splitWords } from "../comptoir/python.ts";
import { ROOT, SERVERS, connect } from "./servers.ts";

// Phrasings that have no business in a tool's description: a server that uses them may be trying to steer
// Claude (tool poisoning). It is only an alert: nothing replaces reading. The word boundary after “.env” is
// Python's, which counts accented letters as letters.
export const SUSPICIOUS = new RegExp(
  "ignore (all|any|previous|the above)|instead of|do not tell|don't tell" +
    "|system prompt|<important>|before using any other tool" +
    `|send .{0,40}to https?://|~/\\.ssh|\\.env${AFTER}|api[_ -]?key|password`,
  "giu",
);

/** The passages of a description that deserve a careful reread. */
export const alerts = (text: string | null | undefined): string[] => [...new Set([...(text ?? "").matchAll(SUSPICIOUS)].map((m) => m[0]))].sort();

/** The text on one line, cut at width characters (counted as Python counts them). */
export function short(text: string | null | undefined, width = 400): string {
  const line = [...splitWords(text ?? "").join(" ")];
  return line.length <= width ? line.join("") : line.slice(0, width - 1).join("") + "…";
}

/** snake_case: the field names the Python version shows (model_dump of the Python MCP SDK 2). */
const toSnake = (object: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(object).map(([k, v]) => [k.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`), v]));

export async function explore(name: string): Promise<number> {
  let flagged = 0;
  const { client, protocol } = await connect(SERVERS[name]!());
  try {
    const info = client.getServerVersion();
    console.log(`Server: ${info?.name ?? "?"} ${info?.version ?? ""}`);
    console.log(`Negotiated protocol: ${protocol}`);
    const instructions = client.getInstructions();
    if (instructions) console.log(`Server instructions: ${short(instructions)}`);
    const capabilities = client.getServerCapabilities();

    const { tools } = await client.listTools();
    console.log(`\n${tools.length} tool(s)`);
    for (const tool of tools) {
      const properties = Object.keys(tool.inputSchema?.properties ?? {});
      const annotations = tool.annotations ? toSnake(tool.annotations) : {};
      console.log(`- ${tool.name}(${properties.join(", ")}) ${Object.keys(annotations).length ? repr(annotations) : ""}`);
      console.log(`    ${short(tool.description, 600)}`);
      for (const passage of alerts(tool.description)) {
        flagged++;
        console.log(`    ⚠ to reread: “${passage}”`);
      }
    }

    if (capabilities?.resources) {
      const { resources } = await client.listResources();
      console.log(`\n${resources.length} resource(s)`);
      for (const r of resources.slice(0, 10)) console.log(`- ${r.uri}  (${r.mimeType || "?"}) ${short(r.name, 80)}`);
      if (resources.length > 10) console.log(`  … and ${resources.length - 10} more`);
    }
    if (capabilities?.prompts) {
      const { prompts } = await client.listPrompts();
      console.log(`\n${prompts.length} prompt(s)`);
      for (const p of prompts) console.log(`- ${p.name}(${(p.arguments ?? []).map((a) => a.name).join(", ")}): ${short(p.description, 200)}`);
    }
  } finally {
    await client.close();
  }
  console.log(flagged ? `\n${flagged} passage(s) to reread.` : "\nNo suspicious phrasing found.");
  return flagged;
}

export function countOrders(): number {
  const db = new DatabaseSync(join(ROOT, "customer_data", "orders_exploration.sqlite3"), { readOnly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
const texts = (r: ToolResult): string => r.content.filter((c) => c.type === "text").map((c) => c.text).join(" ");

/** Asks the orders server to delete an order. Returns true if the write is refused. */
export async function tryToWrite(): Promise<boolean> {
  const before = countOrders();
  const { client } = await connect(SERVERS.orders!());
  let write: ToolResult;
  try {
    const read = (await client.callTool({ name: "execute_sql", arguments: { sql: "SELECT COUNT(*) AS orders FROM orders" } })) as ToolResult;
    console.log("Read:", short(texts(read), 200));
    write = (await client.callTool({ name: "execute_sql", arguments: { sql: "DELETE FROM orders WHERE id = 'C-0001'" } })) as ToolResult;
    console.log("Write:", write.isError ? "refused" : "ACCEPTED", "—", short(texts(write), 300));
  } finally {
    await client.close();
  }
  const after = countOrders();
  console.log(`Orders in the copy: ${before} before, ${after} after.`);
  return Boolean(write.isError) && before === after;
}

async function main(): Promise<void> {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: { "try-to-write": { type: "boolean", default: false } }, // check that the orders server refuses a write
  });
  const server = positionals[0];
  const choices = Object.keys(SERVERS).sort();
  if (!server || !choices.includes(server)) {
    console.error(`error: server to choose from ${choices.join(", ")}`);
    process.exit(2);
  }
  if (args["try-to-write"]) {
    if (server !== "orders") {
      console.error("error: --try-to-write only applies to the orders server");
      process.exit(2);
    }
    process.exit((await tryToWrite()) ? 0 : 1);
  }
  await explore(server);
}

if (isMain(import.meta.url)) await main();
