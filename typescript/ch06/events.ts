// Chapter 6: the events of a stream, one by one, with the time of their arrival.
//
// Shows what the SDK receives from the API: message_start, then for each block content_block_start,
// content_block_delta events and content_block_stop, then message_delta (stop reason, cumulative usage)
// and message_stop. The ping events are absorbed by the SDK: you will not see them here.
//
// Run, from the typescript/ folder:  npx tsx ch06/events.ts "Which juices do you have?"

import Anthropic from "@anthropic-ai/sdk";
import { performance } from "node:perf_hooks";
import { buildRequest } from "../comptoir/assistant.ts";
import { cost } from "../comptoir/costs.ts";
import { logCall } from "../comptoir/log.ts";
import { load } from "../comptoir/prompt.ts";

const question = process.argv.slice(2).join(" ") || "Which juices do you have, and at what price?";
const client = new Anthropic();
const prompt = load();
const request = buildRequest(question, { prompt });
const start = performance.now();
let firstText: number | null = null;
const ms = () => (performance.now() - start).toFixed(0).padStart(7);

const stream = client.messages.stream(request);
for await (const event of stream) {
  // The SDK yields only the API's raw events here; its own events (text…) go through stream.on().
  if (event.type === "content_block_start") {
    console.log(`${ms()} ms  content_block_start  (block ${event.index}: ${event.content_block.type})`);
  } else if (event.type === "content_block_delta") {
    if (event.delta.type === "text_delta") {
      firstText ??= performance.now() - start;
      console.log(`${ms()} ms  content_block_delta  ${JSON.stringify(event.delta.text)}`);
    } else {
      console.log(`${ms()} ms  content_block_delta  (${event.delta.type})`);
    }
  } else if (event.type === "message_delta") {
    console.log(`${ms()} ms  message_delta        stop_reason=${event.delta.stop_reason}`);
  } else {
    console.log(`${ms()} ms  ${event.type}`);
  }
}
const message = await stream.finalMessage();

const total = performance.now() - start;
const price = cost(request.model, message.usage);
logCall(stream.request_id, request.model, price, { prompt: prompt.id });
console.log(`\nFirst text after ${(firstText ?? 0).toFixed(0)} ms; full answer after ${total.toFixed(0)} ms.`);
console.log(`Blocks of the final message: ${JSON.stringify(message.content.map((b) => b.type))}`);
console.log(`Cost: ${price}`);
