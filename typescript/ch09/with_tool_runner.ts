// Chapter 9: the same tool loop, handed to the SDK's Tool Runner (in beta).
//
// betaZodTool draws the tool's schema from a Zod schema; the runner calls Claude, runs the tools, sends
// back the results and starts again, until an answer without a tool call, or until max_iterations.
//
// Run, from the typescript/ folder:  npx tsx ch09/with_tool_runner.ts

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../comptoir/config.ts";
import { cost } from "../comptoir/costs.ts";
import { load } from "../comptoir/prompt.ts";
import { Shop } from "../comptoir/shop.ts";
import { toJson } from "../comptoir/tools.ts";

const shop = new Shop(); // in memory: the chapter's fictional stock, nothing is written

const stockCheck = betaZodTool({
  name: "stock_check",
  description:
    "Gives the quantity available today for products in the Délices d'Awa catalog. " +
    "Use it when a customer asks whether a product is available. The names must be those of the catalog, " +
    "exactly. Returns neither prices nor delivery times.",
  inputSchema: z.object({ products: z.array(z.string()).describe("The exact names of the catalog products to check.") }),
  run: ({ products }) =>
    toJson(Object.fromEntries(products.map((p) => [p, shop.catalog.has(p) ? shop.available(p) : "missing from the catalog"]))),
});

const client = new Anthropic();
const runner = client.beta.messages.toolRunner({
  model: config.MODEL,
  max_tokens: 2000,
  max_iterations: 4, // a bound, like MAX_TURNS in the hand-written loop
  system: load("v2").text,
  tools: [stockCheck],
  messages: [{ role: "user", content: "Do you have any pineapple juice and soursop juice left?" }],
});
for await (const message of runner) {
  // One message per call to Claude. The cost is displayed, but nothing records it: neither budget nor
  // log, unlike the Comptoir.
  console.log(`[${message.stop_reason}] ${JSON.stringify(message.content.map((b) => b.type))} ${cost(config.MODEL, message.usage)}`);
}
const final = await runner.done();
console.log(`\n${final.content.map((b) => (b.type === "text" ? b.text : "")).join("")}`);
