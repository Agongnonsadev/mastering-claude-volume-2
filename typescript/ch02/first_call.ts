// Chapter 2: the same call with the official SDK, and its cost.
//
// Run, from the typescript/ folder:  npx tsx ch02/first_call.ts

import Anthropic from "@anthropic-ai/sdk";
import { cost } from "../comptoir/costs.ts";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

const message = await client.messages.create({
  model: "claude-sonnet-5-5",
  max_tokens: 1000,
  messages: [{ role: "user", content: "Hello! Introduce yourself in one sentence." }],
});

for (const block of message.content) {
  if (block.type === "text") console.log(block.text);
}

console.log("Request ID:", message._request_id);
console.log("Stop reason:", message.stop_reason);
console.log("Tokens:", message.usage.input_tokens, "input,", message.usage.output_tokens, "output");
console.log("Cost:", String(cost(message.model, message.usage)));
