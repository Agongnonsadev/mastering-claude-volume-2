// Chapter 11: the same questions, without cache then with, and what the usage field says.
//
// Three experiments:
// 1. a prompt too short for the cache: no error, but nothing is cached;
// 2. five questions, the whole base in the request, without cache;
// 3. the same, with a cache point after the base, preceded by a warm-up (max_tokens=0).
//
// Run, from the typescript/ folder:  npx tsx ch11/cache_before_after.ts --max-budget 0.5

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "node:util";
import type { MessagesClient } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import { type Cost, cost } from "../comptoir/costs.ts";
import { buildRequest, loadPrompt } from "../comptoir/doc_assistant.ts";
import { loadKnowledge } from "../comptoir/knowledge.ts";
import { logCall } from "../comptoir/log.ts";
import { loadQuestions } from "./shared.ts";

const HEADER =
  `${"series".padEnd(10)} ${"no.".padStart(3)} ${"input".padStart(7)} ${"written".padStart(7)} ${"read".padStart(7)} ` +
  `${"output".padStart(7)} ${"cost ($)".padStart(9)} ${"time".padStart(7)}`;

const line = (series: string, number: number, price: Cost, duration: number): string =>
  `${series.padEnd(10)} ${String(number).padStart(3)} ${String(price.input).padStart(7)} ${String(price.cacheWrite).padStart(7)} ` +
  `${String(price.cacheRead).padStart(7)} ${String(price.output).padStart(7)} ${price.dollars.toFixed(5).padStart(9)} ${duration.toFixed(1).padStart(6)}s`;

async function callClaude(client: MessagesClient, request: Anthropic.MessageCreateParamsNonStreaming, label: string): Promise<[Cost, number]> {
  const start = performance.now();
  const message = await client.messages.create(request);
  const duration = (performance.now() - start) / 1000;
  const price = cost(request.model, message.usage);
  logCall(message._request_id, request.model, price, { prompt: label });
  return [price, duration];
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: { questions: { type: "string", default: "5" }, "max-budget": { type: "string", default: "0.5" } } });
  const maxBudget = Number(args["max-budget"]);
  const client = new Anthropic();
  const base = loadKnowledge();
  const prompt = loadPrompt();
  const questions = loadQuestions().slice(0, Number(args.questions)).map((c) => c.question);
  let spent = 0;

  console.log("1. A prompt too short for the cache");
  const short: Anthropic.MessageCreateParamsNonStreaming = {
    model: config.MODEL,
    max_tokens: 50,
    system: [{ type: "text", text: "You are the Comptoir of Délices d'Awa.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "Hello" }],
  };
  let [price, duration] = await callClaude(client, short, "too-short");
  spent += price.dollars;
  console.log(
    `   written to the cache: ${price.cacheWrite}, read from the cache: ${price.cacheRead}, input: ${price.input} ` +
      "(below the minimum length, the cache point is ignored, without an error)\n",
  );

  console.log(HEADER);
  const totals: Record<string, number> = {};
  for (const [series, cache] of [["no cache", false], ["with cache", true]] as const) {
    let total = 0;
    if (cache) {
      // Warm-up: the base is written to the cache before the first real question.
      const warmup = buildRequest("warm-up", base, { prompt, cache: true });
      warmup.max_tokens = 0;
      [price, duration] = await callClaude(client, warmup, "warmup");
      console.log(line("warm-up", 0, price, duration));
      total += price.dollars;
    }
    for (const [i, question] of questions.entries()) {
      if (spent + total >= maxBudget) {
        console.log(`Budget of $${maxBudget} reached: stopping.`);
        return;
      }
      [price, duration] = await callClaude(client, buildRequest(question, base, { prompt, cache }), `${prompt.id}/${series}`);
      console.log(line(series, i + 1, price, duration));
      total += price.dollars;
    }
    totals[series] = total;
    spent += total;
  }
  console.log(
    `\nTotal without cache: $${totals["no cache"]!.toFixed(4)}; with cache, warm-up included: ` +
      `$${totals["with cache"]!.toFixed(4)}; spent by the script: $${spent.toFixed(4)}`,
  );
}

await main();
