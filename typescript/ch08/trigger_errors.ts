// Chapter 8: trigger each error on purpose, and read the Comptoir's diagnosis.
//
// Run, from the typescript/ folder:
//     npx tsx ch08/trigger_errors.ts              (all cases)
//     npx tsx ch08/trigger_errors.ts key budget   (some cases)
//
// Cost: almost nothing. The errors returned by the API (key, model, invalid request) are not billed; the
// max_tokens case makes a call of a few tokens; the budget case only does a count, which is free.

import Anthropic from "@anthropic-ai/sdk";
import { buildRequest } from "../comptoir/assistant.ts";
import { Budget } from "../comptoir/budget.ts";
import { callClaude } from "../comptoir/call.ts";
import { config } from "../comptoir/config.ts";
import { ComptoirError, type Diagnostic, diagnose, diagnoseStop } from "../comptoir/errors.ts";

const QUESTION: Anthropic.MessageParam[] = [{ role: "user", content: "Hello" }];

function show(name: string, diagnostic: Diagnostic | null): void {
  if (diagnostic === null) {
    console.log(`${name.padEnd(10)} no anomaly`);
    return;
  }
  console.log(`${name.padEnd(10)} ${diagnostic.code} (origin: ${diagnostic.origin}, retry: ${diagnostic.retry ? "yes" : "no"})`);
  console.log(`${"".padEnd(10)} customer: ${diagnostic.forCustomer}`);
  console.log(`${"".padEnd(10)} Yao:      ${diagnostic.forYao}`);
}

async function attempt(name: string, client: Anthropic, request: Partial<Anthropic.MessageCreateParamsNonStreaming> = {}): Promise<void> {
  try {
    const message = await client.messages.create({ model: config.MODEL, max_tokens: 50, messages: QUESTION, ...request });
    show(name, diagnoseStop(message));
  } catch (error) {
    show(name, diagnose(error));
  }
}

/** A tiny customer quota: the call is refused before it goes out. */
async function budgetCase(): Promise<void> {
  config.CUSTOMER_DAILY_QUOTA = 0.000001;
  try {
    await callClaude(new Anthropic(), buildRequest("Hello"), new Budget(), "budget-trial");
  } catch (error) {
    if (error instanceof ComptoirError) show("budget", error.diagnostic);
    else throw error;
  }
}

const CASES: Record<string, () => Promise<void>> = {
  // A wrong key, written in plain text on purpose: it gives access to nothing.
  key: () => attempt("key", new Anthropic({ apiKey: "sk-ant-deliberately-fake-key", maxRetries: 0 })),
  model: () => attempt("model", new Anthropic({ maxRetries: 0 }), { model: "claude-nonexistent-model" }),
  prefill: () => attempt("prefill", new Anthropic({ maxRetries: 0 }), { messages: [...QUESTION, { role: "assistant", content: "Hello, I" }] }),
  timeout: () => attempt("timeout", new Anthropic({ timeout: 1, maxRetries: 0 })), // 1 ms: the SDK counts in milliseconds
  max_tokens: () => attempt("max_tokens", new Anthropic(), { max_tokens: 5 }),
  budget: budgetCase,
};

const names = process.argv.slice(2);
for (const name of names.length ? names : Object.keys(CASES)) {
  const c = CASES[name];
  if (!c) throw new Error(`Unknown case: ${name} (possible cases: ${Object.keys(CASES).join(", ")})`);
  await c();
}
