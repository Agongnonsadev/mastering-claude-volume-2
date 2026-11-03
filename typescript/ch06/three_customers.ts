// Chapter 6: three customers write at the same time. One after the other, then together.
//
// The SDK is asynchronous: the server does not wait idly for Claude's answer; while one answer is
// arriving, it starts another. The limit caps the number of simultaneous calls, to stay under the
// organization's rate limits.
//
// Run, from the typescript/ folder:  npx tsx ch06/three_customers.ts
// Cost: six short calls (three questions, twice).

import Anthropic from "@anthropic-ai/sdk";
import { performance } from "node:perf_hooks";
import { buildRequest } from "../comptoir/assistant.ts";
import { config } from "../comptoir/config.ts";
import { cost } from "../comptoir/costs.ts";
import { logCall } from "../comptoir/log.ts";
import { type SystemPrompt, load } from "../comptoir/prompt.ts";

const QUESTIONS = [
  "Hello, do you deliver to Akpakpa?",
  "How much are 6 bottles of bissap?",
  "How long does the ginger syrup keep?",
];

const MAX_CONCURRENT_CALLS = 2;

/** At most `maximum` tasks at a time, like asyncio.Semaphore in Python. */
function limit(maximum: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= maximum) await new Promise<void>((ok) => waiting.push(ok));
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

async function answer(client: Anthropic, question: string, prompt: SystemPrompt): Promise<number> {
  const request = buildRequest(question, { prompt });
  const message = await client.messages.create(request);
  const price = cost(request.model, message.usage);
  logCall(message._request_id, request.model, price, { prompt: prompt.id });
  return price.dollars;
}

const client = new Anthropic({ timeout: config.TIMEOUT_S * 1000 });
const prompt = load();
const total = (costs: number[]) => costs.reduce((a, b) => a + b, 0).toFixed(4);

let start = performance.now();
const oneAtATime = limit(1);
let costs: number[] = [];
for (const q of QUESTIONS) costs.push(await oneAtATime(() => answer(client, q, prompt)));
console.log(`One after the other: ${((performance.now() - start) / 1000).toFixed(1)} s, $${total(costs)}`);

start = performance.now();
const together = limit(MAX_CONCURRENT_CALLS);
costs = await Promise.all(QUESTIONS.map((q) => together(() => answer(client, q, prompt))));
console.log(`Together (at most ${MAX_CONCURRENT_CALLS} at a time): ${((performance.now() - start) / 1000).toFixed(1)} s, $${total(costs)}`);
