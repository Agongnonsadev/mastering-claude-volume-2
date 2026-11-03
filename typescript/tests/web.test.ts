// The Comptoir on the web, with a fake client: SSE stream, resumption, one answer at a time; budget,
// refusal and errors (chapter 8); limits, maximum size and purge (chapter 18). The tests of
// python/tests/test_web.py and those of the server in python/tests/test_ch18.py.

import type { HttpBindings } from "@hono/node-server";
import { serve } from "@hono/node-server";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { WebSocketServer } from "ws";
import { Budget } from "../comptoir/budget.ts";
import { Conversations } from "../comptoir/conversations.ts";
import { isoformat } from "../comptoir/database.ts";
import { REFUSAL, UNAVAILABLE } from "../comptoir/errors.ts";
import { load, loadData } from "../comptoir/prompt.ts";
import { Generation } from "../comptoir/streaming.ts";
import { type Server, createApp } from "../comptoir/web.ts";
import { FakeStream, FakeStreamingClient, apiError, finalMessage, restoreConfig, setConfig, temporaryLog } from "./fake_clients.ts";

beforeEach(() => {
  temporaryLog();
  // BUDGET_DB: never a file during the tests.
  setConfig({ MODEL: "claude-sonnet-5-5", EFFORT: null, BUDGET_DB: ":memory:", CUSTOMER_DAILY_QUOTA: 0.15, NETWORK_DAILY_QUOTA: 0.4 });
});
afterEach(restoreConfig);

/** Cuts an SSE stream into [name, data]. The comments (signs of life) are ignored. */
function readSse(body: string): [string, Record<string, unknown>][] {
  const events: [string, Record<string, unknown>][] = [];
  for (const block of body.split("\n\n")) {
    const lines = block.split("\n");
    const name = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
    if (name) events.push([name, JSON.parse(data)]);
  }
  return events;
}

/** A connection seen from the Node server: the address it comes from (like TestClient(client=...) in Python). */
const from = (address: string) => ({ incoming: { socket: { remoteAddress: address } } }) as unknown as HttpBindings;

async function send(s: Server, text: string, messageId: string, conversation: string | null = null, received = 0, address = "127.0.0.1") {
  const r = await s.app.request(
    "/api/messages",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation, message_id: messageId, text, since: received }) },
    from(address),
  );
  const body = await r.text();
  return { r, events: r.status === 200 ? readSse(body) : [] };
}

const conversationOf = (events: [string, Record<string, unknown>][]) => String(events[0]![1].conversation);

test("the page is displayed", async () => {
  const r = await createApp(new FakeStreamingClient(), new Conversations()).app.request("/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Awa's Comptoir/);
});

test("the answer arrives in chunks, then is stored", async () => {
  const conversations = new Conversations();
  const s = createApp(new FakeStreamingClient(new FakeStream(["We have ", "bissap."])), conversations);
  const { r, events } = await send(s, "Your juices?", "message-0001");
  assert.match(r.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.deepEqual(events.map(([name]) => name), ["conversation", "text", "text", "end"]);
  const history = conversations.history(conversationOf(events));
  assert.deepEqual(history[0], { role: "user", content: "<customer_message>\nYour juices?\n</customer_message>" });
  // The answer is stored as is, thinking included.
  assert.deepEqual((history[1]!.content as { type: string }[]).map((b) => b.type), ["thinking", "text"]);
});

test("the next turn sends the history back without rewriting it", async () => {
  const client = new FakeStreamingClient(new FakeStream(["Yes, bissap."]), new FakeStream(["Six bottles: 6,000 FCFA."]));
  const s = createApp(client, new Conversations());
  const { events } = await send(s, "Do you have bissap?", "message-0001");
  await send(s, "And for six bottles?", "message-0002", conversationOf(events));
  const [first, second] = client.requests;
  assert.deepEqual(second!.messages.slice(0, 1), first!.messages); // same beginning, to the character
  assert.equal(second!.messages[1]!.role, "assistant");
  assert.equal((second!.messages[1]!.content as { signature?: string }[])[0]!.signature, "test-signature");
});

test("the same message sent again after a cut does not call Claude twice", async () => {
  const client = new FakeStreamingClient(new FakeStream(["We have ", "bissap", "."]));
  const s = createApp(client, new Conversations());
  const first = await send(s, "Your juices?", "message-0001");
  // The browser had received 2 chunks before the cut: it asks for the rest.
  const resumed = await send(s, "Your juices?", "message-0001", conversationOf(first.events), 2);
  assert.equal(client.requests.length, 1);
  assert.deepEqual(resumed.events.filter(([name]) => name === "text").map(([, d]) => d), [{ text: "." }]);
  assert.equal(resumed.events.at(-1)![0], "end");
});

test("one answer at a time per conversation", async () => {
  const conversations = new Conversations();
  const s = createApp(new FakeStreamingClient(), conversations);
  const conversation = conversations.create(load().id);
  s.comptoir.generations.set("message-in-progress", new Generation(conversation)); // not finished yet
  const { r } = await send(s, "And the ginger?", "message-0002", conversation);
  assert.equal(r.status, 409);
});

test("an expired conversation starts from zero", async () => {
  const conversations = new Conversations();
  const old = conversations.create(load().id);
  conversations.db.prepare("UPDATE conversations SET last_activity = ?").run(isoformat(new Date(Date.now() - 2 * 24 * 3600 * 1000)));
  const client = new FakeStreamingClient(new FakeStream(["Hello!"]));
  const { events } = await send(createApp(client, conversations), "Hello", "message-0001", old);
  assert.equal(events[0]![1].renewed, "expired");
  assert.notEqual(events[0]![1].conversation, old);
  assert.deepEqual(client.requests[0]!.messages.slice(0, -1), []); // nothing from the old conversation
});

test("a modified catalog opens a new conversation", async () => {
  const client = new FakeStreamingClient(new FakeStream(["Bissap is 1,000 FCFA."]), new FakeStream(["Bissap is 1,100 FCFA."]));
  const data = loadData();
  const s = createApp(client, new Conversations(), undefined, () => load("v1", data));
  const first = await send(s, "The price of bissap?", "message-0001");
  const conversation = conversationOf(first.events);
  // Awa changes a price: the rendered system prompt changes, so does its fingerprint.
  data.products[0]!.price_fcfa += 100;
  const second = await send(s, "And now?", "message-0002", conversation);
  assert.equal(second.events[0]![1].renewed, "new_prompt");
  assert.notEqual(second.events[0]![1].conversation, conversation);
  // The old history, and its thinking blocks, are not sent back with the new prompt.
  assert.equal(client.requests[1]!.messages.length, 1);
});

test("an error is told to the customer, and nothing is stored", async () => {
  const conversations = new Conversations();
  const client = new FakeStreamingClient(new FakeStream(["x"], { cutAt: 0, error: apiError(400, "invalid_request_error") }));
  const { events } = await send(createApp(client, conversations), "Hello", "message-0001");
  assert.deepEqual(events.at(-1), ["error", { type: "error", message: UNAVAILABLE }]);
  assert.deepEqual(conversations.history(conversationOf(events)), []);
});

test("the same conversation over WebSocket", async () => {
  const { app } = createApp(new FakeStreamingClient(new FakeStream(["We deliver ", "in Cotonou."])), new Conversations());
  const websockets = new WebSocketServer({ noServer: true });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1", websocket: { server: websockets } });
  await new Promise((ok) => server.once("listening", ok));
  const { port } = server.address() as { port: number };
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received: Record<string, unknown>[] = [];
    await new Promise<void>((ok, fail) => {
      ws.onerror = () => fail(new Error("WebSocket in error"));
      ws.onopen = () => ws.send(JSON.stringify({ message_id: "message-0001", text: "Do you deliver to Akpakpa?" }));
      ws.onmessage = (e) => {
        received.push(JSON.parse(String(e.data)));
        if (received.length === 4) ok();
      };
    });
    ws.close();
    assert.deepEqual(received.map((e) => e.type), ["conversation", "text", "text", "end"]);
    assert.equal(received.filter((e) => e.type === "text").map((e) => e.text).join(""), "We deliver in Cotonou.");
  } finally {
    websockets.close();
    await new Promise((ok) => server.close(ok));
  }
});

// --- Chapter 8: budget, refusal, errors ---------------------------------------------------

test("over budget, the customer is warned and Claude is not called", async () => {
  setConfig({ CUSTOMER_DAILY_QUOTA: 0.0001 });
  const client = new FakeStreamingClient(new FakeStream(["Hello!"]));
  const { events } = await send(createApp(client, new Conversations(), new Budget()), "Hello", "message-0001");
  assert.deepEqual(events.at(-1), ["error", { type: "error", message: UNAVAILABLE }]);
  assert.deepEqual(client.requests, []); // the counting took place, not the call
  assert.equal(client.counts, 1);
});

test("a refusal erases the beginning and does not enter the history", async () => {
  const conversations = new Conversations();
  const refusal = new FakeStream(["I'm going to "], { message: finalMessage("I'm going to ", { stopReason: "refusal" }) });
  const { events } = await send(createApp(new FakeStreamingClient(refusal), conversations), "A refused request", "message-0001");
  assert.deepEqual(events.at(-1), ["refusal", { type: "refusal", message: REFUSAL }]);
  assert.deepEqual(conversations.history(conversationOf(events)), []);
});

test("an API error before any text releases the budget", async () => {
  const budget = new Budget();
  const client = new FakeStreamingClient(new FakeStream(["x"], { cutAt: 0, error: apiError(400, "invalid_request_error") }));
  await send(createApp(client, new Conversations(), budget), "Hello", "message-0001");
  assert.equal(budget.forDay(), 0);
});

// --- Chapter 18: limits per address, maximum size, purge ------------------------------

/** A client that always answers, for the limit tests. */
const always = () => {
  const client = new FakeStreamingClient();
  client.messages.stream = (request) => {
    client.requests.push(request);
    return new FakeStream(["Hello!"]);
  };
  return client;
};

test("an address cannot open a conversation at each message", async () => {
  setConfig({ CONVERSATIONS_PER_HOUR_LIMIT: 3 });
  const s = createApp(always(), new Conversations(), new Budget());
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await send(s, "Hello", crypto.randomUUID(), null, 0, "196.168.10.20")).r.status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  // A real customer, elsewhere, is not bothered.
  assert.equal((await send(s, "Hello", crypto.randomUUID(), null, 0, "196.168.77.5")).r.status, 200);
});

test("a burst stops, and the browser knows when to come back", async () => {
  setConfig({ MESSAGES_PER_MINUTE_LIMIT: 4 });
  const s = createApp(always(), new Conversations(), new Budget());
  const responses = [];
  for (let i = 0; i < 6; i++) responses.push((await send(s, "Hello", crypto.randomUUID(), null, 0, "196.168.10.20")).r);
  assert.deepEqual(responses.map((r) => r.status), [200, 200, 200, 200, 429, 429]);
  assert.ok(Number(responses.at(-1)!.headers.get("retry-after")) >= 1);
});

test("a giant body is refused before being read, even sent in chunks", async () => {
  const { app } = createApp(always(), new Conversations(), new Budget());
  const body = JSON.stringify({ conversation: null, message_id: crypto.randomUUID(), text: "b".repeat(3_000_000) });
  const withLength = await app.request("/api/messages", {
    method: "POST", body, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
  });
  // The same body in chunks, without Content-Length.
  const chunks = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < body.length; i += 10_000) controller.enqueue(new TextEncoder().encode(body.slice(i, i + 10_000)));
      controller.close();
    },
  });
  const inChunks = await app.request("/api/messages", {
    method: "POST", body: chunks, headers: { "content-type": "application/json" }, duplex: "half",
  } as RequestInit);
  assert.equal(withLength.status, 413);
  assert.equal(inChunks.status, 413);
});

test("the page says you are talking to an AI and never inserts HTML", async () => {
  const page = await (await createApp(always(), new Conversations()).app.request("/")).text();
  assert.match(page.replaceAll("\n", " "), /artificial intelligence, not a person/);
  const script = page.split("<script>")[1]!;
  const code = script.split("\n").map((l) => l.split("//")[0]).join("\n");
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
});

test("old conversations are purged at startup", () => {
  const conversations = new Conversations();
  const old = conversations.create("p");
  conversations.addTurn(old, [
    { role: "user", content: "I'm Koffi, 97 00 00 00" },
    { role: "assistant", content: "Hello Koffi" },
  ], 10);
  conversations.db.prepare("UPDATE conversations SET last_activity = ?").run(isoformat(new Date(Date.now() - 31 * 24 * 3600 * 1000)));
  const stop = createApp(always(), conversations, new Budget()).start();
  stop();
  assert.equal(conversations.exists(old), false);
});
