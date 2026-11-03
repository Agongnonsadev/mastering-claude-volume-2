// Chapter 2: count the tokens of the same message in several languages, before sending it.
//
// Counting is free (it only has its own rate limit).
// Run, from the typescript/ folder:
//     npx tsx ch02/count_tokens.ts
//     npx tsx ch02/count_tokens.ts "The same sentence in your local language"

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-5-5";

// The same order in French, the language of most of Awa's customers, and in English.
const sentences: Record<string, string> = {
  French:
    "Bonjour, je voudrais commander deux bouteilles de jus de bissap " +
    "et un sirop de gingembre, livrés demain matin à Cotonou.",
  English:
    "Hello, I would like to order two bottles of bissap juice " +
    "and one ginger syrup, delivered tomorrow morning in Cotonou.",
};
const other = process.argv.slice(2).join(" ");
if (other) sentences["other language"] = other;

const client = new Anthropic();

for (const [language, sentence] of Object.entries(sentences)) {
  const count = await client.messages.countTokens({
    model: MODEL,
    messages: [{ role: "user", content: sentence }],
  });
  console.log(`${language.padEnd(14)} ${String(sentence.length).padStart(4)} characters   ${String(count.input_tokens).padStart(4)} tokens`);
}
