// The tool loop, written by hand (chapter 9).
//
// Claude answers; if it asks for tools (stop_reason “tool_use”), the code runs them and sends back all
// the results in a single message; this goes on until a final answer. Each call goes through
// comptoir/call.ts: budget, log and diagnoses of chapter 8.

import type Anthropic from "@anthropic-ai/sdk";
import type { Budget } from "./budget.ts";
import { callClaude } from "./call.ts";
import type { MessagesClient } from "./client.ts";
import { toBlocks } from "./conversations.ts";
import { ComptoirError, type Diagnostic, UNAVAILABLE } from "./errors.ts";
import { Execution, type Tools } from "./tools.ts";

export const MAX_TURNS = 6; // beyond that, something is going round in circles: stop rather than pay

export interface Turn {
  text: string; //                              Claude's final answer, for the customer
  newMessages: Anthropic.MessageParam[]; //     to add to the history, in order, without rewriting anything
  execution: Execution;
  stop: Diagnostic | null;
  cost: number; //                              all the calls of the turn, in dollars (chapter 12)
}

/** request: a request of the Comptoir (comptoir/assistant.ts), whose last message is the customer's. */
export async function converse(
  client: MessagesClient,
  request: Anthropic.MessageCreateParamsNonStreaming,
  tools: Tools,
  budget: Budget,
  customerId: string,
  prompt: string | null = null,
  maxTurns = MAX_TURNS,
): Promise<Turn> {
  const messages = [...request.messages];
  const newMessages: Anthropic.MessageParam[] = [];
  const execution = new Execution();
  let total = 0;
  for (let i = 0; i < maxTurns; i++) {
    const reply = await callClaude(client, { ...request, messages }, budget, customerId, prompt);
    total += reply.cost.dollars;
    // The assistant message is kept as is: thinking, text and tool calls. In a tool turn, the thinking
    // blocks must come back intact with the results.
    const assistant = { role: "assistant", content: toBlocks(reply.message.content) } as Anthropic.MessageParam;
    messages.push(assistant);
    newMessages.push(assistant);
    if (reply.message.stop_reason !== "tool_use") {
      return { text: reply.text, newMessages, execution, stop: reply.stop, cost: total };
    }
    const calls = reply.message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    // All the results in ONE message, in the order of the calls, and nothing before them.
    const results: Anthropic.MessageParam = { role: "user", content: calls.map((call) => tools.execute(call, execution)) };
    messages.push(results);
    newMessages.push(results);
  }
  throw new ComptoirError({
    code: "loop_too_long", retry: false, origin: "integration", forCustomer: UNAVAILABLE,
    forYao: `More than ${maxTurns} tool turns for a single message: read the trace.`, waitS: null,
  });
}
