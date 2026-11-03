// Chapter 14: Awa's evening question, asked to the Comptoir, which reads the database through a local MCP
// server.
//
// Run, from the typescript/ folder (PAID CALL):
//     npx tsx ch14/evening_question.ts
//     npx tsx ch14/evening_question.ts "Which juice sold best in Fidjrossè in September?"
//
// The API's MCP connector only reaches remote servers, over HTTP. For a local server, which talks over
// stdio, it is your code that is the MCP client: it launches DBHub, asks it for its tools, and the SDK
// converts them for the Tool Runner (mcpTools, from @anthropic-ai/sdk/helpers/beta/mcp). Claude writes the
// SQL queries; the database does the counting; DBHub refuses any write.

import Anthropic from "@anthropic-ai/sdk";
import { type MCPClientLike, mcpTools } from "@anthropic-ai/sdk/helpers/beta/mcp";
import { parseArgs } from "node:util";
import { config } from "../comptoir/config.ts";
import { cost } from "../comptoir/costs.ts";
import { isMain } from "../comptoir/launch.ts";
import { logCall } from "../comptoir/log.ts";
import { pythonJson } from "../comptoir/python.ts";
import { fixed } from "../comptoir/rounding.ts";
import { connect, orders } from "./servers.ts";

export const QUESTION =
  "How many bottles of bissap juice did we sell last week, from Monday, October 12 to " +
  "Sunday, October 18, and in which neighborhoods mostly?";

// What Yao learned by exploring the database with Claude Code becomes the Comptoir's context: fewer turns to
// find the schema again, so fewer tokens.
export const SYSTEM = `You are the Comptoir, the assistant of Délices d'Awa. Awa asks you a question about her sales; you answer it with the execute_sql tool, on a read-only SQLite database.

The database:
- an order (table orders) is a confirmed summary (table summaries, column status = 'confirmed'); orders.summary = summaries.id;
- the products of a summary are in summaries.lines, as JSON: [{"product": ..., "quantity": ..., "unit_price": ...}]; read them with json_each;
- the customer's neighborhood is summaries.neighborhood; the dates (created_at) are in Cotonou time (+01:00);
- the amounts are in FCFA.

Rules:
- the figures come from the database: have SQL do the sums and the counts, never in your head;
- answer Awa in English, politely, in four sentences at most, with the exact figures;
- if the database does not allow you to answer, say so.
Today is Wednesday, October 21, 2026.`;

export async function ask(question: string, maxBudget: number, maxIterations = 8): Promise<[string, number, number]> {
  const client = new Anthropic({ timeout: config.TIMEOUT_S * 1000, maxRetries: config.RETRIES });
  let spent = 0;
  let turns = 0;
  let text = "";
  const { client: mcpClient } = await connect(orders()); // launches DBHub, like Claude Code
  try {
    const { tools } = await mcpClient.listTools();
    const runner = client.beta.messages.toolRunner({
      model: config.MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: "user", content: question }],
      // The MCP client fits: its callTool can also return the old { toolResult } shape, which the SDK's type
      // does not provide for, but DBHub answers with content.
      tools: mcpTools(tools, mcpClient as unknown as MCPClientLike),
      max_iterations: maxIterations,
    });
    for await (const message of runner) {
      turns++;
      const price = cost(config.MODEL, message.usage);
      spent += price.dollars;
      logCall((message as { _request_id?: string | null })._request_id, config.MODEL, price, { customer: "ch14-evening", stop_reason: message.stop_reason, origin: "local-mcp" });
      for (const block of message.content) {
        if (block.type === "tool_use") console.log(`SQL: ${pythonJson(block.input)}`);
        else if (block.type === "text") text = block.text;
      }
      if (spent >= maxBudget && message.stop_reason === "tool_use") {
        console.log(`Stop: $${fixed(spent, 4)} spent, ceiling of $${maxBudget} reached.`);
        break;
      }
    }
  } finally {
    await mcpClient.close();
  }
  return [text, spent, turns];
}

async function main(): Promise<void> {
  const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { "max-budget": { type: "string", default: "0.10" } } });
  const [text, spent, turns] = await ask(positionals[0] ?? QUESTION, Number(args["max-budget"]));
  console.log(`\n${text}\n\n${turns} turn(s), $${fixed(spent, 4)}`);
}

if (isMain(import.meta.url)) await main();
