// Chapter 12: does Claude Haiku 5.5 think when told not to? Seven requests, one question.
//
// The same question, asked seven times of Claude Haiku 5.5 with max_tokens 1,000: without a document, with
// Awa's base as search_result blocks (citations on or off), then as raw text. We record the thinking tokens
// and the stop reason. Cost: less than a cent.
//
// Run, from the typescript/ folder:  npx tsx ch12/thinking_and_citations.ts

import Anthropic from "@anthropic-ai/sdk";
import { cost } from "../comptoir/costs.ts";
import { buildRequest, loadPrompt } from "../comptoir/doc_assistant.ts";
import { type Chunk, loadKnowledge } from "../comptoir/knowledge.ts";
import { isMain } from "../comptoir/launch.ts";
import { logCall } from "../comptoir/log.ts";
import { customerMessage } from "../comptoir/prompt.ts";

const MODEL = "claude-haiku-5-5";
const QUESTION = "I confirm my order on Saturday at 3 p.m.: when will I be delivered?";
type Request = Anthropic.MessageCreateParamsNonStreaming;

export function cases(base: Chunk[]): [string, Request][] {
  const documents = (citations: boolean, effort: "low" | null = null, disabled = true): Request => {
    const r = buildRequest(QUESTION, base, { cache: "1h", model: MODEL, maxTokens: 1000, noThinking: disabled, withCitations: citations });
    if (effort) r.output_config = { effort };
    return r;
  };
  const alone: Request = {
    model: MODEL,
    max_tokens: 1000,
    system: loadPrompt().text,
    messages: [{ role: "user", content: customerMessage(QUESTION) }],
  };
  const text = base.map((c) => `## ${c.title}\n${c.text}`).join("\n\n");
  const raw: Request = { ...alone, messages: [{ role: "user", content: `<documents>\n${text}\n</documents>\n\n` + customerMessage(QUESTION) }] };
  return [
    ["no document, thinking disabled", { ...alone, thinking: { type: "disabled" } }],
    ["no document, effort low", { ...alone, output_config: { effort: "low" } }],
    ["search_result with citations, disabled", documents(true)],
    ["search_result with citations, effort low", documents(true, "low", false)],
    ["search_result with citations, disabled and low", documents(true, "low")],
    ["search_result without citations, disabled", documents(false)],
    ["base as raw text, disabled", { ...raw, thinking: { type: "disabled" } }],
  ];
}

async function main(): Promise<void> {
  const client = new Anthropic();
  let total = 0;
  for (const [name, request] of cases(loadKnowledge())) {
    const response = await client.messages.create(request);
    const price = cost(MODEL, response.usage);
    total += price.dollars;
    logCall(response._request_id, MODEL, price, { prompt: "ch12-thinking", stop_reason: response.stop_reason });
    const thinking = response.usage.output_tokens_details?.thinking_tokens || 0;
    console.log(`${name.padEnd(50)} thinking ${String(thinking).padStart(4)} tokens  output ${String(response.usage.output_tokens).padStart(4)}  stop ${response.stop_reason}`);
  }
  console.log(`\nCost: $${total.toFixed(4)}`);
}

if (isMain(import.meta.url)) await main();
