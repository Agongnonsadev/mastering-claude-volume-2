// Chapter 18: the attacks that cost nothing, and the audit's checks, run on the code.
//
// Run, from the typescript/ folder (FREE: a fake client, no call to the API):
//     npx tsx ch18/code_audit.ts --label before
//     npx tsx ch18/code_audit.ts --label after
//
// Five attacks, on the web Comptoir (chapter 6), on its tools and on the repository:
//   6. a new conversation at each message, to escape the quota per customer;
//   7. a burst of messages, then a giant request body;
//   8. HTML in Claude's answer, to run a script on the customer's side;
//   9. another customer's conversation: a guessed ID, tools turned away from their use;
//  10. the API key: repository, Git history, logs, results.
// And two checks, reading the code against its promises:
//   C1. are the personal data deleted on the promised date?
//   C2. does the customer know they are talking to an AI?
//
// The same script serves before and after the fixes: it attacks through the public doors (the web API, the
// tools, the files), without assuming anything about the code that guards them. Result: a table, and
// ch18/results/audit-<label>.json.

import type Anthropic from "@anthropic-ai/sdk";
import type { HttpBindings } from "@hono/node-server";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { Budget } from "../comptoir/budget.ts";
import { config } from "../comptoir/config.ts";
import { Conversations } from "../comptoir/conversations.ts";
import { randomId } from "../comptoir/database.ts";
import { AFTER, BEFORE } from "../comptoir/guard.ts";
import { PYTHON, ROOT, isMain } from "../comptoir/launch.ts";
import { pythonJson, str } from "../comptoir/python.ts";
import { round } from "../comptoir/rounding.ts";
import { Shop } from "../comptoir/shop.ts";
import type { MessageStream, StreamingClient } from "../comptoir/streaming.ts";
import { Execution, Tools } from "../comptoir/tools.ts";
import { createApp } from "../comptoir/web.ts";
import { nowUtc, timestamp } from "../ch17/suite.ts";

const REPOSITORY = join(ROOT, "..", "..", ".."); // the root of the Git repository
const RESULTS = join(ROOT, "ch18", "results");

const ATTACKER = "196.168.10.20"; // a fixed address for the attacker
const CUSTOMER = "196.168.77.5"; //  and another one for a real customer
const TRAPPED_HTML = "<img src=x onerror=\"alert('Comptoir')\">";
const KEY = /sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,}/;
const KEY_FOR_GIT = "sk-ant-(api|admin|oat)[0-9]{2}-[A-Za-z0-9_-]{20,}"; // the same, for git grep -E

// --- A fake client: it always answers, without billing anything -------------------------------------

/** The SDK's client, as the Comptoir sees it: each message gets the same answer, 1,000 input tokens and 50 output. */
export class FakeClient implements StreamingClient {
  calls = 0;
  readonly messages: StreamingClient["messages"];

  constructor(readonly text = "Hello! What can I do for you?") {
    const message = {
      id: "msg_audit", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text, citations: null }],
      usage: { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: null, cache_read_input_tokens: null },
    } as unknown as Anthropic.Message;
    this.messages = {
      stream: (): MessageStream => {
        this.calls++;
        return {
          request_id: "req_audit",
          async *[Symbol.asyncIterator]() {
            yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as Anthropic.MessageStreamEvent;
          },
          finalMessage: async () => message,
        };
      },
      countTokens: async () => ({ input_tokens: 1000 }),
    };
  }
}

function application(text?: string) {
  const client = text ? new FakeClient(text) : new FakeClient();
  const budget = new Budget(":memory:");
  return { ...createApp(client, new Conversations(), budget), client, budget };
}

type App = ReturnType<typeof application>["app"];

const from = (address: string) => ({ incoming: { socket: { remoteAddress: address } } }) as unknown as HttpBindings;

function events(body: string): [string, Record<string, unknown>][] {
  const output: [string, Record<string, unknown>][] = [];
  for (const block of body.split("\n\n")) {
    const lines = block.split("\n");
    const name = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
    if (name) output.push([name, JSON.parse(data)]);
  }
  return output;
}

/** [HTTP status, outcome, conversation]; outcome: end, error, refusal or the status itself. */
async function send(app: App, address: string, text: string, conversation: string | null = null): Promise<[number, string, string | null]> {
  const r = await app.request("/api/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversation, message_id: randomId(), text, since: 0 }),
  }, from(address));
  if (r.status !== 200) return [r.status, String(r.status), conversation];
  const ev = events(await r.text());
  const conv = (ev.find(([n]) => n === "conversation")?.[1].conversation as string | undefined) ?? null;
  const outcome = ev.find(([n]) => ["end", "error", "refusal"].includes(n))?.[0] ?? "none";
  return [200, outcome, conv];
}

type Result = Record<string, unknown> & { verdict: string };

// --- The attacks ------------------------------------------------------------------------------

/** A new conversation at each message: the quota per customer never sees the same customer twice. */
async function attack6NewConversations(maxTrials = 1000): Promise<Result> {
  const { app, client, budget } = application();
  let accepted = 0;
  let firstRefusal: string | null = null;
  for (let i = 0; i < maxTrials; i++) {
    const [, outcome] = await send(app, ATTACKER, "Hello, do you have bissap juice?");
    if (outcome === "end") accepted++;
    else {
      firstRefusal = outcome;
      break;
    }
  }
  const [, customerOutcome] = await send(app, CUSTOMER, "Hello, I'd like to order 6 pineapple juices.");
  return {
    messages_accepted: accepted,
    stop: firstRefusal,
    spending_of_the_day_dollars: round(budget.forDay(), 4),
    calls_to_claude: client.calls,
    a_real_customer_afterwards: customerOutcome,
    verdict: customerOutcome !== "end" ? "flaw" : "held",
  };
}

/** 60 messages in a minute in the same conversation, then a text that is too long, then a 3 MB body. */
async function attack7BurstAndGiantBody(): Promise<Result> {
  const { app } = application();
  let accepted = 0;
  let conversation: string | null = null;
  let start = performance.now();
  for (let i = 0; i < 60; i++) {
    let outcome: string;
    [, outcome, conversation] = await send(app, ATTACKER, "Another question about bissap.", conversation);
    if (outcome === "end") accepted++;
  }
  const duration = (performance.now() - start) / 1000;
  const [longStatus] = await send(app, ATTACKER, "a".repeat(10_000));
  const body = JSON.stringify({ conversation: null, message_id: randomId(), text: "b".repeat(3_000_000) });
  start = performance.now();
  const r = await app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body }, from(ATTACKER));
  const bodyDuration = (performance.now() - start) / 1000;
  return {
    burst_accepted: `${accepted} out of 60 in ${duration.toFixed(1)} s`,
    text_of_10000_characters: longStatus,
    body_of_3_mb: r.status,
    body_of_3_mb_handled_in_s: round(bodyDuration, 3),
    verdict: accepted === 60 || r.status !== 413 ? "flaw" : "held",
  };
}

/** Claude answers with trapped HTML: does the stream carry it as is, does the page run it? */
async function attack8HtmlInTheAnswer(): Promise<Result> {
  const { app } = application(TRAPPED_HTML);
  const r = await app.request("/api/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversation: null, message_id: randomId(), text: "Write the juice's name in HTML for my website", since: 0 }),
  }, from(CUSTOMER));
  const texts = events(await r.text()).filter(([n]) => n === "text").map(([, d]) => String(d.text ?? ""));
  const page = await (await app.request("/")).text();
  const script = page.includes("<script>") ? page.split("<script>")[1]!.split("</script>")[0]! : "";
  const code = script.split("\n").map((l) => l.split("//")[0]).join("\n"); // without the comments
  const dangerous = [...new Set(code.match(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/g) ?? [])].sort();
  return {
    html_received_as_text: texts.join("").includes(TRAPPED_HTML),
    dangerous_insertions_in_the_page: dangerous,
    verdict: dangerous.length ? "flaw" : "held",
  };
}

/** Guess a conversation's ID; turn a tool toward another customer's order. */
async function attack9AnotherCustomersConversation(): Promise<Result> {
  const { app } = application();
  const guesses = ["0".repeat(32), "1", "rachidatou-conversation"];
  const guessed: (string | null)[] = [];
  for (const c of guesses) guessed.push((await send(app, ATTACKER, "Remind me of my address.", c))[2]);
  // The conversation the tool sees is the one the code gave it, whatever the arguments.
  const shop = new Shop(":memory:");
  const victim = randomId();
  const attacker = randomId();
  shop.prepare(victim, [{ product: "Bissap juice", quantity: 6 }], "Rachidatou", "Zogbo");
  new Tools(shop, attacker).execute({
    id: "toolu_audit", name: "order_prepare",
    input: { lines: [{ product: "Bissap juice", quantity: 1 }], customer_name: "X", neighborhood: "Zogbo", conversation: victim },
  }, new Execution());
  const victimStatuses = shop.summaries(victim).map((s) => s.status);
  const accepted = guessed.filter((c) => c !== null && guesses.includes(c)).length;
  return {
    guessed_ids_accepted: accepted,
    victim_s_summary: victimStatuses,
    tools_available: "stock_check, order_prepare, pass_to_awa (none reads another conversation)",
    verdict: victimStatuses.length === 1 && victimStatuses[0] === "pending" && !accepted ? "held" : "flaw",
  };
}

function git(...args: string[]): string {
  return spawnSync("git", ["-C", REPOSITORY, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 }).stdout ?? "";
}

function files(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => join(f.parentPath, f.name));
}

/** Look for an API key: tracked files, the whole Git history, logs and results on the disk. */
function attack10TheKey(): Result {
  const tracked = git("grep", "-I", "-n", "-E", KEY_FOR_GIT).split("\n").filter(Boolean);
  const history = git("log", "-p", "--all", "--no-color").match(new RegExp(KEY.source, "g")) ?? [];
  const onDisk: string[] = [];
  for (const folder of ["log", "customer_data", "ch17/results", "ch18/results", "ch19/results"]) {
    for (const f of files(join(ROOT, folder))) {
      if ([".jsonl", ".json", ".txt", ".csv", ".md", ".html"].includes(extname(f)) && KEY.test(readFileSync(f, "utf8"))) {
        onDisk.push(relative(ROOT, f).replaceAll("\\", "/"));
      }
    }
  }
  const ignored = git("check-ignore", "-v", join(ROOT, ".env"), join(ROOT, "ch19", "deployment", ".env")).trim();
  return {
    keys_in_the_tracked_files: tracked.length,
    keys_in_the_git_history: history.length,
    local_files_with_a_key: onDisk,
    env_ignored_by_git: Boolean(ignored),
    verdict: !tracked.length && !history.length && !onDisk.length && ignored ? "held" : "flaw",
  };
}

// --- The checks -----------------------------------------------------------------------------

/** The conversations are promised deleted after 30 days (chapter 6): who deletes them? */
function check1Retention(): Result {
  const calls: string[] = [];
  const sources = [
    ...readdirSync(join(ROOT, "comptoir")).filter((f) => f.endsWith(".ts")).map((f) => join(ROOT, "comptoir", f)),
    ...readdirSync(ROOT).filter((d) => /^ch\d+$/.test(d) && statSync(join(ROOT, d)).isDirectory())
      .flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith(".ts")).map((f) => join(ROOT, d, f))),
  ];
  for (const f of sources) {
    if (f.endsWith("code_audit.ts")) continue;
    readFileSync(f, "utf8").split(/\r?\n/).forEach((line, n) => {
      if (/\.purge\(/.test(line)) calls.push(`${relative(ROOT, f).replaceAll("\\", "/")}:${n + 1}`);
    });
  }
  const tablesWithoutPurge = ["summaries", "requests"].filter(() => typeof Shop.prototype.purge !== "function");
  return {
    calls_to_purge_in_the_application: calls,
    shop_tables_never_purged: tablesWithoutPurge,
    verdict: calls.length && !tablesWithoutPurge.length ? "held" : "flaw",
  };
}

/** Anthropic's usage policy: an assistant that talks to customers must say it is an AI. */
function check2AiDisclosure(): Result {
  const page = readFileSync(join(PYTHON, "comptoir", "pages", "comptoir.html"), "utf8");
  const visible = page.replace(/<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>|<[^>]+>/g, " ");
  const disclosure = new RegExp(`artificial\\s+intelligence|${BEFORE}AI${AFTER}`, "u").test(visible);
  return { disclosure_in_the_page: disclosure, verdict: disclosure ? "held" : "flaw" };
}

export const ATTACKS: Record<string, () => Result | Promise<Result>> = {
  "6. A new conversation at each message": attack6NewConversations,
  "7. Burst and giant body": attack7BurstAndGiantBody,
  "8. HTML in the answer": attack8HtmlInTheAnswer,
  "9. Another customer's conversation": attack9AnotherCustomersConversation,
  "10. The API key": attack10TheKey,
  "C1. Data kept beyond 30 days": check1Retention,
  "C2. Does the customer know they are talking to an AI?": check2AiDisclosure,
};

export async function audit(): Promise<Record<string, Result>> {
  const folder = mkdtempSync(join(tmpdir(), "audit-"));
  const log = config.LOG;
  // Nothing is written to the Comptoir's log: the audit has its own, thrown away at the end.
  config.LOG = join(folder, "audit-log.jsonl");
  try {
    const results: Record<string, Result> = {};
    for (const [name, attack] of Object.entries(ATTACKS)) {
      const start = performance.now();
      results[name] = await attack();
      results[name].duration_s = round((performance.now() - start) / 1000, 2);
    }
    return results;
  } finally {
    config.LOG = log;
    rmSync(folder, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: { label: { type: "string", default: timestamp() } } });
  const results = await audit();
  for (const [name, r] of Object.entries(results)) {
    console.log(`${r.verdict.toUpperCase().padEnd(6)} ${name}`);
    for (const [key, value] of Object.entries(r)) if (key !== "verdict") console.log(`         ${key}: ${str(value)}`);
  }
  mkdirSync(RESULTS, { recursive: true });
  const output = join(RESULTS, `audit-${args.label}.json`);
  writeFileSync(output, pythonJson({ date: nowUtc(), results }, 1), "utf8");
  console.log(`→ ${output}`);
}

if (isMain(import.meta.url)) await main();
