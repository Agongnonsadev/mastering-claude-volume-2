// Chapter 16: query the online Comptoir from the API, through the MCP connector, with an OAuth token.
//
// Run, from the typescript/ folder (PAID CALL), after npx tsx ch16/connect.ts on the same public address
// (which keeps the token in customer_data/client_tokens.json):
//     npx tsx ch16/ask_through_the_api.ts https://<public-address>/mcp
//
// The MCP connector only reaches a public server, over https://. It is up to your application to obtain the
// OAuth token and to renew it: the API simply presents it to the server (authorization_token). Here, a
// denylist: all the server's tools, except the two that touch the stock. The resulting assistant can only
// read.

import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { trace } from "../ch14/ask_the_docs.ts";
import { makeClient } from "../comptoir/call.ts";
import { config } from "../comptoir/config.ts";
import { cost } from "../comptoir/costs.ts";
import { ROOT, isMain } from "../comptoir/launch.ts";
import { logCall } from "../comptoir/log.ts";
import { fixed } from "../comptoir/rounding.ts";

export const TOKENS = join(ROOT, "customer_data", "client_tokens.json");
export const QUESTION =
  "How many orders did we have on Saturday, October 17, 2026, for what total, and which products " +
  "are out of stock?";

export function request(address: string, token: string): Record<string, unknown> & { model: string } {
  return {
    model: config.DOCUMENTS_MODEL,
    max_tokens: 800,
    system: "You answer Awa, in English, politely, in two sentences, with the exact figures from the tools.",
    messages: [{ role: "user", content: QUESTION }],
    mcp_servers: [{ type: "url", url: address, name: "comptoir", authorization_token: token }],
    tools: [
      {
        type: "mcp_toolset",
        mcp_server_name: "comptoir",
        // Denylist: everything is allowed, except what writes.
        configs: { prepare_correction: { enabled: false }, apply_correction: { enabled: false } },
      },
    ],
    betas: ["mcp-client-2025-11-20"],
  };
}

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true });
  const address = positionals[0];
  if (positionals.length !== 1 || !address) stop("Usage: npx tsx ch16/ask_through_the_api.ts https://<public-address>/mcp");
  if (!address.startsWith("https://")) stop("The MCP connector accepts only an https:// address.");
  if (!existsSync(TOKENS)) stop("No token: run npx tsx ch16/connect.ts first.");
  const token = (JSON.parse(readFileSync(TOKENS, "utf8")) as { tokens: { access_token: string } }).tokens.access_token; // never displayed
  const params = request(address, token);
  const message = await makeClient().beta.messages.create(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);
  const price = cost(params.model, message.usage);
  logCall((message as { _request_id?: string | null })._request_id, params.model, price, { customer: "ch16-api", stop_reason: message.stop_reason, origin: "mcp-connector-oauth" });
  for (const line of trace(message.content)) console.log(line);
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const right = text.includes("6 orders") && text.includes("50") && text.includes("500") && text.toLowerCase().includes("soursop");
  console.log(`\n${text}\n\n${right ? "Right" : "TO CHECK"}; stop: ${message.stop_reason}; ${message.usage.input_tokens} input tokens; cost: $${fixed(price.dollars, 4)}`);
}

if (isMain(import.meta.url)) await main();
