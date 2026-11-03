// Chapter 3: list the models available to your key, with their limits and their retirement date.
//
// The Models API generates no text: it consumes no tokens.
// Run, from the typescript/ folder:  npx tsx ch03/list_models.ts

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const thousands = (n: number | null): string => (n ? n.toLocaleString("en-US") : "?");

for await (const model of client.models.list()) {
  const retirement = model.retires_at ? model.retires_at.slice(0, 10) : "not announced";
  console.log(
    `${model.id.padEnd(28)} ${model.lifecycle.padEnd(11)} context ${thousands(model.max_input_tokens).padStart(9)} · ` +
      `output ${thousands(model.max_tokens).padStart(7)} · retirement: ${retirement}`,
  );
}
