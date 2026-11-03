// Chapter 14: check the Comptoir's prices in Anthropic's documentation, through the MCP connector.
//
// Run, from the typescript/ folder (PAID CALL):
//     npx tsx ch14/ask_the_docs.ts                    # allowlist: search_docs and get_doc
//     npx tsx ch14/ask_the_docs.ts --pin              # the same, with a pinned tool list
//
// The API's MCP connector (beta) plugs a remote MCP server into a request: it is the API that connects to
// the server, calls its tools and returns everything in a single response. Here, the official server of
// the documentation (https://platform.claude.com/docs/mcp, public, without authentication). Claude looks for
// the prices and returns them as JSON; the code compares them with comptoir/costs.ts. Claude does not decide
// whether a price has changed: it reads it, the code compares.
//
// --pin: with the header mcp-client-2026-09-15, the first response returns the server's tool list; the
// script saves it in ch14/pinned_tools/doc-claude.json. The following times, it sends this list: the API no
// longer asks the server about its tools, and a server that changed its descriptions would not change what
// Claude reads. Before each call, the script compares the pinned list with the one the server announces
// today (free) and stops if it has changed. The list pinned by the Python version
// (python/ch14/pinned_tools/) serves as long as this one has none of its own.

import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { makeClient } from "../comptoir/call.ts";
import { config } from "../comptoir/config.ts";
import { toBlocks } from "../comptoir/conversations.ts";
import { RATES, type Rate, cost } from "../comptoir/costs.ts";
import { PYTHON, ROOT, isMain } from "../comptoir/launch.ts";
import { logCall } from "../comptoir/log.ts";
import { equal, floatText, numberOf, parsePythonJson, pythonJson, str } from "../comptoir/python.ts";
import { fixed } from "../comptoir/rounding.ts";
import { DOC_CLAUDE, connect } from "./servers.ts";

export const SERVER = "doc-claude";
export const BETA = "mcp-client-2025-11-20";
export const PIN_BETA = "mcp-client-2026-09-15";
export const PIN = join(ROOT, "ch14", "pinned_tools", `${SERVER}.json`);
const PYTHON_PIN = join(PYTHON, "ch14", "pinned_tools", `${SERVER}.json`);
export const CHECKED_MODELS = ["claude-sonnet-5-5", "claude-haiku-5-5"];
export const ITEMS = ["input", "write_5m", "write_1h", "cache_read", "output"] as const;
type Item = (typeof ITEMS)[number];
// The items of the schema (those of the Python version) and the fields of Rate that match them.
const FIELD: Record<Item, keyof Rate> = { input: "input", write_5m: "write5m", write_1h: "write1h", cache_read: "cacheRead", output: "output" };

export const SYSTEM =
  "You check facts in Claude's official documentation, with the tools of the doc-claude MCP server. " +
  "Never answer from memory: search, read the page, then copy the figures as the page gives them. " +
  "If a figure is not there, put the model in not_found rather than guess.";

export const SCHEMA = {
  type: "object",
  properties: {
    prices: {
      type: "array",
      items: {
        type: "object",
        properties: {
          model: { type: "string", description: "the model's ID, for example claude-haiku-5-5" },
          ...Object.fromEntries(ITEMS.map((i) => [i, { type: "number", description: "dollars per million tokens" }])),
          source: { type: "string", description: "address of the page read" },
        },
        required: ["model", ...ITEMS, "source"],
        additionalProperties: false,
      },
    },
    not_found: { type: "array", items: { type: "string" } },
  },
  required: ["prices", "not_found"],
  additionalProperties: false,
};

export const question = (): string =>
  "Give, for " + CHECKED_MODELS.join(" and ") + ", the published prices per million tokens: input, " +
  "writing to the 5-minute cache, writing to the one-hour cache, reading from the cache, output. " +
  "Take the API's base prices (not the Batch API, not long prompts).";

export type PinnedTool = { name: string; description?: string | null; input_schema: unknown };

/** The allowlist: every tool turned off by default, then two turned back on. */
export function toolset(pinned: PinnedTool[] | null): Record<string, unknown> {
  const tools: Record<string, unknown> = {
    type: "mcp_toolset",
    mcp_server_name: SERVER,
    default_config: { enabled: false },
    configs: { search_docs: { enabled: true }, get_doc: { enabled: true } },
  };
  if (pinned !== null) tools.tools = pinned;
  return tools;
}

export function request(pinned: PinnedTool[] | null, beta: string): Record<string, unknown> & { model: string; messages: Anthropic.Beta.BetaMessageParam[] } {
  return {
    model: config.DOCUMENTS_MODEL,
    max_tokens: 3000,
    system: SYSTEM,
    messages: [{ role: "user", content: question() }],
    mcp_servers: [{ type: "url", url: DOC_CLAUDE, name: SERVER }],
    tools: [toolset(pinned)],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    betas: [beta],
  };
}

type Block = Record<string, unknown> & { type: string };

/** What happened in the response, block by block: the trace of a call with the connector. */
export function trace(content: unknown[]): string[] {
  const lines: string[] = [];
  for (const block of content as Block[]) {
    if (block.type === "mcp_tool_listing") lines.push(`tool list of ${block.mcp_server_name}: ${(block.tools as unknown[]).length} tool(s)`);
    else if (block.type === "mcp_tool_use") lines.push(`call ${block.server_name}.${block.name} ${pythonJson(block.input)}`);
    else if (block.type === "mcp_tool_result") {
      const size = ((block.content as { text?: string }[] | null) ?? []).reduce((s, c) => s + [...(c.text ?? "")].length, 0);
      lines.push(`  result ${block.is_error ? "in error" : "received"}: ${size} characters`);
    } else if (block.type === "text") lines.push(`text: ${[...String(block.text)].length} characters`);
  }
  return lines;
}

type PriceLine = Record<Item, unknown> & { model: string; source: string };

/** The gaps between the prices read in the documentation and those of comptoir/costs.ts. */
export function compare(answer: { prices: PriceLine[]; not_found?: string[] }): string[] {
  const gaps = (answer.not_found ?? []).map((m) => `${m}: price not found in the documentation`);
  const seen = new Set<string>();
  for (const line of answer.prices) {
    const model = line.model;
    if (!CHECKED_MODELS.includes(model)) continue;
    seen.add(model);
    const rate = RATES[model]!;
    for (const item of ITEMS) {
      // The prices of costs.py are floats in the Python version: “$10.0”.
      if (Math.abs(rate[FIELD[item]] - numberOf(line[item])) > 1e-9) {
        gaps.push(`${model} ${item}: $${floatText(rate[FIELD[item]])} in costs.py, $${str(line[item])} in the documentation (${line.source})`);
      }
    }
  }
  gaps.push(...CHECKED_MODELS.filter((m) => !seen.has(m)).map((m) => `${m}: missing from the answer`));
  return gaps;
}

/** The tool list the server announces today, in the connector's format. Free. */
export async function announcedTools(): Promise<PinnedTool[]> {
  const { client } = await connect(DOC_CLAUDE);
  try {
    return (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description ?? null, input_schema: t.inputSchema }));
  } finally {
    await client.close();
  }
}

/** The tools whose definition has changed since the pinning (or appeared, or disappeared). */
export function pinUpToDate(pinned: PinnedTool[], announced: PinnedTool[]): string[] {
  const before = new Map(pinned.map((t) => [t.name, t]));
  const now = new Map(announced.map((t) => [t.name, t]));
  const changed = [...before.keys()].filter((n) => now.has(n) && !equal(before.get(n), now.get(n)));
  const appeared = [...now.keys()].filter((n) => !before.has(n)).map((n) => `+${n}`);
  const disappeared = [...before.keys()].filter((n) => !now.has(n)).map((n) => `-${n}`);
  return [...changed, ...appeared, ...disappeared].sort();
}

/** Python's SystemExit: the message on the error output, and code 1. */
function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      pin: { type: "boolean", default: false }, //               pin the server's tool list
      "max-budget": { type: "string", default: "0.10" }, //     ceiling of the session, in dollars
    },
  });
  const maxBudget = Number(args["max-budget"]);
  let pinned: PinnedTool[] | null = null;
  let beta = BETA;
  if (args.pin) {
    beta = PIN_BETA;
    const read = [PIN, PYTHON_PIN].find(existsSync);
    if (read) {
      pinned = JSON.parse(readFileSync(read, "utf8")) as PinnedTool[];
      const changed = pinUpToDate(pinned, await announcedTools());
      if (changed.length) {
        stop(
          `The server has changed its tools since the pinning: ${changed.join(", ")}. Reread them ` +
            `(npx tsx ch14/explore_server.ts doc), then delete ${read} to pin the new list.`,
        );
      }
      console.log(`Pinned tool list: ${pinned.length} tool(s), identical to the server's.`);
    }
  }

  const client = makeClient();
  const { messages: first, ...params } = request(pinned, beta);
  const messages = [...first];
  let spent = 0;
  let calls = 0;
  let message: Anthropic.Beta.BetaMessage;
  while (true) {
    // No prior counting: the count_tokens endpoint rejects mcp_servers, and the tools' results come in
    // during the call. The ceiling is therefore checked after each call.
    message = await client.beta.messages.create({ ...params, messages } as Anthropic.Beta.MessageCreateParamsNonStreaming);
    calls++;
    const price = cost(params.model, message.usage);
    spent += price.dollars;
    logCall((message as { _request_id?: string | null })._request_id, params.model, price, { customer: "ch14-doc", stop_reason: message.stop_reason, origin: "mcp-connector" });
    for (const line of trace(message.content)) console.log(line);
    if (args.pin && pinned === null) {
      for (const block of message.content as unknown as Block[]) {
        if (block.type === "mcp_tool_listing" && block.mcp_server_name === SERVER) {
          mkdirSync(dirname(PIN), { recursive: true });
          writeFileSync(PIN, pythonJson(toBlocks(block.tools), 2), "utf8");
          console.log(`Tool list pinned in ${relative(ROOT, PIN)}`);
          pinned = block.tools as PinnedTool[];
        }
      }
    }
    if (message.stop_reason !== "pause_turn") break;
    if (spent >= maxBudget || calls >= 4) stop(`Stop: $${fixed(spent, 4)} spent in ${calls} calls, ceiling reached.`);
    // pause_turn: the API interrupted a long round of tools; its response is sent back as is.
    messages.push({ role: "assistant", content: toBlocks(message.content) as Anthropic.Beta.BetaContentBlockParam[] });
  }

  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const answer = parsePythonJson(text) as { prices: PriceLine[]; not_found: string[] };
  const gaps = compare(answer);
  console.log();
  for (const line of answer.prices) console.log(`${line.model}: ` + ITEMS.map((i) => `${i} ${str(line[i])}`).join(", ") + `  (${line.source})`);
  console.log("\nPrices in comptoir/costs.ts:", gaps.length ? "GAPS" : "up to date.");
  for (const g of gaps) console.log(" -", g);
  console.log(`\n${calls} call(s), ${message.usage.input_tokens} input tokens at the last one, cost: $${fixed(spent, 4)}`);
  if (spent > maxBudget) console.log(`Warning: the ceiling of $${maxBudget} is exceeded; it can only be checked after the call.`);
}

if (isMain(import.meta.url)) await main();
