// The Comptoir on the command line, tested with a fake client: no paid call
// (python/tests/test_ch02_comptoir_cli.py).

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SYSTEM_PROMPT, answer } from "../ch02/comptoir_cli.ts";
import type { MessagesClient } from "../comptoir/client.ts";
import { PYTHON } from "../comptoir/launch.ts";
import { approx, fakeMessage, temporaryLog } from "./fake_clients.ts";

/** Imitates client.messages.create and keeps the last request to inspect it. */
function fakeClient() {
  const client = {
    lastRequest: null as Anthropic.MessageCreateParamsNonStreaming | null,
    messages: {
      create: async (request: Anthropic.MessageCreateParamsNonStreaming) => {
        client.lastRequest = request;
        return fakeMessage({
          content: [
            { type: "thinking", thinking: "", signature: "" }, // thinking hidden by default
            { type: "text", text: "The ginger syrup costs 2,500 FCFA a bottle.", citations: null },
          ],
          usage: { input_tokens: 420, output_tokens: 80, output_tokens_details: { thinking_tokens: 30 } },
          id: "req_test_0001",
        });
      },
      countTokens: async () => ({ input_tokens: 0 }),
    },
  } satisfies MessagesClient & { lastRequest: unknown };
  return client;
}

test("answers and ignores the thinking blocks", async () => {
  temporaryLog();
  const { text, price } = await answer(fakeClient(), "How much is the ginger syrup?", "claude-sonnet-5-5");
  assert.equal(text, "The ginger syrup costs 2,500 FCFA a bottle.");
  assert.equal(price.thinking, 30);
  approx(price.dollars, (420 * 2 + 80 * 10) / 1_000_000);
});

test("sends the system prompt and the question, without temperature", async () => {
  temporaryLog();
  const client = fakeClient();
  await answer(client, "Do you deliver to Calavi?", "claude-sonnet-5-5");
  const request = client.lastRequest!;
  assert.equal(request.model, "claude-sonnet-5-5");
  assert.match(String(request.system), /Délices d'Awa/);
  assert.deepEqual(request.messages, [{ role: "user", content: "Do you deliver to Calavi?" }]);
  assert.ok(!("temperature" in request)); // removed by API 2026-10-21
});

test("the log contains neither key nor message", async () => {
  const log = temporaryLog();
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  try {
    await answer(fakeClient(), "My number is 0197000000", "claude-sonnet-5-5");
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  }
  const content = readFileSync(log, "utf8");
  const line = JSON.parse(content);
  assert.equal(line.request, "req_test_0001");
  assert.equal(line.input_tokens, 420);
  assert.ok(!content.includes("sk-ant"));
  assert.ok(!content.includes("0197000000"));
});

test("the system prompt is that of the Python version, word for word", () => {
  const source = readFileSync(join(PYTHON, "ch02", "comptoir_cli.py"), "utf8").replace(/\r\n/g, "\n");
  const prompt = /SYSTEM_PROMPT = """([\s\S]*?)"""/.exec(source)?.[1];
  assert.equal(SYSTEM_PROMPT, prompt);
});
