// Chapter 5: an instruction from Awa added during the conversation, without touching the prompt.
//
// The system prompt does not change (and its cache remains valid, chapter 11): the instruction arrives as
// a system message placed right after the customer's message.
//
// Run, from the typescript/ folder:  npx tsx ch05/mid_conversation_instruction.ts

import Anthropic from "@anthropic-ai/sdk";
import { answer } from "../comptoir/assistant.ts";

const INSTRUCTION =
  "Information from Awa, valid today only: soursop juice is out of stock " +
  "until tomorrow morning. Do not offer it; offer pineapple or ginger instead.";

const client = new Anthropic();
const question = "Hello, I'd like 3 bottles of soursop for this evening.";

for (const instructions of [[], [INSTRUCTION]]) {
  const { text, price } = await answer(client, question, { instructions });
  console.log(instructions.length ? "With the instruction:" : "Without an instruction:");
  console.log(text);
  console.log(`[${price}]\n`);
}
