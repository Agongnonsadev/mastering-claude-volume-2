// Chapter 2: a call to Claude in raw HTTP, without the SDK, with Node's fetch only.
//
// Run, from the typescript/ folder:  npx tsx ch02/http_call.ts

const requestBody = {
  model: "claude-sonnet-5-5",
  max_tokens: 1000,
  messages: [{ role: "user", content: "Hello! Introduce yourself in one sentence." }],
};

const key = process.env.ANTHROPIC_API_KEY; // read from the environment, never written here
if (!key) throw new Error("The ANTHROPIC_API_KEY environment variable is not set.");

const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": key,
    "anthropic-version": "2026-10-21", // the API version since October 21, 2026 (chapter 21)
    "content-type": "application/json",
  },
  body: JSON.stringify(requestBody),
  signal: AbortSignal.timeout(60_000),
});

const requestId = response.headers.get("request-id");
const body = (await response.json()) as {
  content: { type: string; text?: string }[];
  stop_reason: string;
  usage: Record<string, unknown>;
};
if (!response.ok) throw new Error(`Error ${response.status} (request ${requestId}): ${JSON.stringify(body)}`);

// The response is a list of blocks: we keep only the text blocks.
const text = body.content.map((block) => (block.type === "text" ? block.text : "")).join("");

console.log(text);
console.log("Request ID:", requestId);
console.log("Stop reason:", body.stop_reason);
console.log("Usage:", body.usage);
