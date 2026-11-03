// Chapter 10: the text editor tool, run by our code in a closed folder.
//
// Claude rereads the FAQ of Awa's website, compares it with the official terms, and fixes the errors with
// the editor tool. The script works on a copy, in a temporary folder, and displays the differences:
// nothing is modified in the repository. The FAQ is that of the Python version
// (python/ch10/data/faq-template.md).
//
// Run, from the typescript/ folder:  npx tsx ch10/fix_faq.ts

import Anthropic from "@anthropic-ai/sdk";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReceivedMessage } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import { toBlocks } from "../comptoir/conversations.ts";
import { cost } from "../comptoir/costs.ts";
import { splitLines, unifiedDiff } from "../comptoir/diff.ts";
import { Editor, TOOL, readText } from "../comptoir/editor.ts";
import { PYTHON } from "../comptoir/launch.ts";
import { logCall } from "../comptoir/log.ts";
import { loadData, renderTerms } from "../comptoir/prompt.ts";

const FAQ_TEMPLATE = join(PYTHON, "ch10", "data", "faq-template.md");
const MAX_TURNS = 8;

const client = new Anthropic();
const folder = mkdtempSync(join(tmpdir(), "faq-"));
try {
  copyFileSync(FAQ_TEMPLATE, join(folder, "faq.md"));
  const editor = new Editor(folder);
  const instruction =
    "The file faq.md is the FAQ of the Délices d'Awa website. Compare it with the official terms below " +
    "and fix each statement that contradicts them, without changing anything else.\n\n<terms>\n" +
    `${renderTerms(loadData())}\n</terms>`;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: instruction }];
  let total = 0;
  let message!: ReceivedMessage;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    message = await client.messages.create({ model: config.MODEL, max_tokens: 4000, tools: [TOOL], messages });
    const price = cost(config.MODEL, message.usage);
    logCall(message._request_id, config.MODEL, price, { stop_reason: message.stop_reason });
    total += price.dollars;
    messages.push({ role: "assistant", content: toBlocks(message.content) as Anthropic.ContentBlockParam[] });
    const calls = message.content.filter((b) => b.type === "tool_use");
    for (const call of calls) {
      const input = call.input as { command?: string; path?: string };
      console.log(`  tool: ${input.command ?? "None"} ${input.path ?? "None"}`);
    }
    if (message.stop_reason !== "tool_use") break;
    messages.push({ role: "user", content: calls.map((call) => editor.result(call)) });
  }

  console.log("\n" + message.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
  const before = splitLines(readText(FAQ_TEMPLATE), true);
  const after = splitLines(readText(join(folder, "faq.md")), true);
  console.log(unifiedDiff(before, after, "faq.md (before)", "faq.md (after)").join(""));
  console.log(`Cost: $${total.toFixed(4)}`);
} finally {
  // The SDK reports a missing key only at the first send: the folder is deleted in every case.
  rmSync(folder, { recursive: true });
}
