// Chapter 2: the Comptoir on the command line. It answers a customer's question and shows what the
// answer cost.
//
// Run, from the typescript/ folder:
//     npx tsx ch02/comptoir_cli.ts "How much is the ginger syrup?"

import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "node:readline/promises";
import { type MessagesClient, type ReceivedMessage, textOf } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import { type Cost, cost } from "../comptoir/costs.ts";
import { isMain } from "../comptoir/launch.ts";
import { logCall } from "../comptoir/log.ts";

// Version 0 of the system prompt: the bare minimum. Chapter 5 rewrites it.
export const SYSTEM_PROMPT = `You are the Comptoir, the assistant of Délices d'Awa, a business making natural juices and craft syrups in Cotonou (fictional business).

Current information:
- Bissap, ginger, pineapple and soursop juice: 1,000 FCFA for a 500 ml bottle.
- Syrups (bissap, ginger): 2,500 FCFA a bottle.
- Orders through WhatsApp, from 8 a.m. to 7 p.m.
- Delivery in Cotonou: the same day for any order placed before 12 p.m., otherwise the next day. Free from 5 bottles, 500 FCFA below that.
- Payment: Mobile Money (MTN MoMo, Moov Money) or cash on delivery.

Answer in English, in three sentences at most. If the answer is not in this information, say so and offer to pass the question on to Awa.`;

/** Sends the question to the model and returns the text, the cost and the full message. */
export async function answer(
  client: MessagesClient,
  question: string,
  model: string = config.MODEL,
): Promise<{ text: string; price: Cost; message: ReceivedMessage }> {
  const message = await client.messages.create({
    model,
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: question }],
  });
  const price = cost(model, message.usage);
  logCall(message._request_id, model, price);
  return { text: textOf(message), price, message };
}

async function main(): Promise<void> {
  let question = process.argv.slice(2).join(" ");
  if (!question) {
    const keyboard = createInterface({ input: process.stdin, output: process.stdout });
    question = await keyboard.question("Customer's question: ");
    keyboard.close();
  }
  const { text, price, message } = await answer(new Anthropic(), question);
  console.log(text);
  console.log();
  console.log(`[${price.input} input tokens, ${price.output} output tokens (${price.thinking} of them thinking). Cost: ${price}]`);
  if (message.stop_reason !== "end_turn") {
    console.log(`[Warning: answer stopped for the reason “${message.stop_reason}”]`);
  }
}

if (isMain(import.meta.url)) await main();
