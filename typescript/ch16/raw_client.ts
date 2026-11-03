// Chapter 16: speak MCP by hand, over HTTP, to see the messages that the SDKs exchange.
//
// Run, from the typescript/ folder, after npx tsx ch16/connect.ts (which keeps a token):
//     npx tsx ch16/raw_client.ts http://localhost:8016/mcp                          # 2026-07-28 revision
//     npx tsx ch16/raw_client.ts http://localhost:8016/mcp --revision 2025-11-25    # for this server
//
// Three JSON-RPC requests of the 2026-07-28 revision, sent with fetch and nothing else: server/discover,
// tools/list, tools/call. On this revision, no handshake: each request carries its own version, the client's
// identity and its capabilities (in _meta), and the server returns no session ID. A request stands on its
// own. The chapter's Python server speaks it; the TypeScript server (SDK 1.32.1) stops at the 2025-11-25
// revision and refuses these requests (400, unsupported version).
//
// --revision 2025-11-25: the handshake (initialize) replaces server/discover; the stateless server returns
// no session ID either, and answers the following requests without remembering it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, isMain } from "../comptoir/launch.ts";

export const VERSION = "2026-07-28";
export const TOKENS = join(ROOT, "customer_data", "client_tokens.json");
const CLIENT = { name: "yao-raw-client", version: "0.1" };

export function message(identifier: number, method: string, params: Record<string, unknown> = {}, revision = VERSION): Record<string, unknown> {
  if (revision !== VERSION) return { jsonrpc: "2.0", id: identifier, method, params };
  const meta = { "io.modelcontextprotocol/protocolVersion": VERSION, "io.modelcontextprotocol/clientInfo": CLIENT, "io.modelcontextprotocol/clientCapabilities": {} };
  return { jsonrpc: "2.0", id: identifier, method, params: { ...params, _meta: meta } };
}

export function headers(token: string, method: string, name?: string, revision = VERSION): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": revision,
  };
  if (revision !== VERSION) return h;
  h["Mcp-Method"] = method;
  if (name) h["Mcp-Name"] = name; // required for tools/call, resources/read and prompts/get
  return h;
}

/** A JSON response, or an event stream (SSE) of which the final message is kept. */
export function readResponse(contentType: string, text: string): unknown {
  if (contentType.startsWith("text/event-stream")) {
    const data = text.split(/\r\n|\r|\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    return JSON.parse(data.at(-1)!);
  }
  return JSON.parse(text);
}

const preview = (value: unknown, length: number): string => [...JSON.stringify(value)].slice(0, length).join("");

async function send(address: string, token: string, identifier: number, method: string, params?: Record<string, unknown>, name?: string, revision = VERSION): Promise<unknown> {
  const body = message(identifier, method, params, revision);
  console.log(`\n→ POST ${address}   ` + (revision === VERSION ? `Mcp-Method: ${method}` + (name ? `   Mcp-Name: ${name}` : "") : method));
  console.log("  " + preview(body, 400));
  const response = await fetch(address, { method: "POST", headers: headers(token, method, name, revision), body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const type = response.headers.get("content-type") ?? "";
  console.log(`← ${response.status} ${type || "None"}   session: ${response.headers.get("mcp-session-id") ?? "none"}`);
  const result = readResponse(type, await response.text());
  console.log("  " + preview(result, 600));
  return result;
}

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { revision: { type: "string", default: VERSION } } });
  const address = positionals[0];
  if (positionals.length !== 1 || !address) stop("Usage: npx tsx ch16/raw_client.ts <address>/mcp [--revision 2025-11-25]");
  if (![VERSION, "2025-11-25"].includes(args.revision)) stop(`--revision: ${VERSION} or 2025-11-25`);
  if (!existsSync(TOKENS)) stop("No token: run npx tsx ch16/connect.ts first.");
  const token = (JSON.parse(readFileSync(TOKENS, "utf8")) as { tokens: { access_token: string } }).tokens.access_token; // never displayed
  const r = args.revision;
  if (r === VERSION) await send(address, token, 1, "server/discover");
  else await send(address, token, 1, "initialize", { protocolVersion: r, capabilities: {}, clientInfo: CLIENT }, undefined, r);
  await send(address, token, 2, "tools/list", undefined, undefined, r);
  await send(address, token, 3, "tools/call", { name: "stock", arguments: {} }, "stock", r);
  console.log("\nWithout a token:");
  const withoutToken = Object.fromEntries(Object.entries(headers("", "tools/list", undefined, r)).filter(([k]) => k !== "Authorization"));
  const response = await fetch(address, { method: "POST", headers: withoutToken, body: JSON.stringify(message(4, "tools/list", undefined, r)) });
  console.log(`← ${response.status}   WWW-Authenticate: ${response.headers.get("www-authenticate")}`);
}

if (isMain(import.meta.url)) await main();
