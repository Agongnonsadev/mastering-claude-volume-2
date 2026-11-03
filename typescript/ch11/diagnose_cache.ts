// Chapter 11: a cache that never serves, and the API that says why (cache diagnostics).
//
// Deliberate mistake: the time is written in the system prompt. The beginning of the request therefore
// changes at every call, and the cache is rewritten every time. The cache diagnostics report it
// (system_changed). Then the fix: the time moves after the cache point, into the message.
//
// Run, from the typescript/ folder:  npx tsx ch11/diagnose_cache.ts
// Cost: four calls with the whole base, three of which write to the cache.

import Anthropic from "@anthropic-ai/sdk";
import { setTimeout as wait } from "node:timers/promises";
import { config } from "../comptoir/config.ts";
import { cost } from "../comptoir/costs.ts";
import { loadPrompt } from "../comptoir/doc_assistant.ts";
import { type Chunk, loadKnowledge, resultBlocks } from "../comptoir/knowledge.ts";
import { logCall } from "../comptoir/log.ts";
import { customerMessage } from "../comptoir/prompt.ts";

type Request = Anthropic.Beta.MessageCreateParamsNonStreaming;

function request(systemPrompt: string, question: string, base: Chunk[], previous: string | null): Request {
  return {
    model: config.MODEL,
    max_tokens: 300,
    system: systemPrompt,
    messages: [{ role: "user", content: [...resultBlocks(base, true), { type: "text", text: customerMessage(question) }] }],
    diagnostics: { previous_message_id: previous },
  };
}

async function run(client: Anthropic, label: string, req: Request): Promise<Anthropic.Beta.BetaMessage> {
  const message = await client.beta.messages.create(req);
  const price = cost(req.model, message.usage);
  logCall(message._request_id, req.model, price, { prompt: label });
  const reason = message.diagnostics ? message.diagnostics.cache_miss_reason : null;
  let detail = reason === null ? "no divergence" : reason.type;
  if (reason && "cache_missed_input_tokens" in reason && reason.cache_missed_input_tokens != null) {
    detail += ` (${reason.cache_missed_input_tokens} tokens lost, estimate)`;
  }
  console.log(
    `${label.padEnd(28)} written ${String(price.cacheWrite).padStart(6)}  read ${String(price.cacheRead).padStart(6)}  ` +
      `$${price.dollars.toFixed(4)}  diagnostics: ${detail}`,
  );
  return message;
}

/** The local time, like datetime.now().strftime("%m/%d/%Y %H:%M:%S"). */
function now(): string {
  const d = new Date();
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${two(d.getMonth() + 1)}/${two(d.getDate())}/${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

const client = new Anthropic();
const base = loadKnowledge();
const prompt = loadPrompt().text;
const question = "Do you deliver on Sundays?";

console.log("The mistake: the time in the system prompt");
const m1 = await run(client, "1. time in the system", request(`${prompt}\n\nIt is ${now()}.`, question, base, null));
await wait(2000);
const m2 = await run(client, "2. same mistake", request(`${prompt}\n\nIt is ${now()}.`, question, base, m1.id));

console.log("\nThe fix: the time after the cache point, in the customer's message");
const m3 = await run(client, "3. stable system", request(prompt, `(It is ${now()}.) ${question}`, base, m2.id));
await wait(2000);
await run(client, "4. stable system, again", request(prompt, `(It is ${now()}.) ${question}`, base, m3.id));
