// Chapter 15: the “Comptoir for Awa” MCP server (python/tests/test_ch15.py). No call to the API, no
// network. The server is questioned by a real MCP client, in memory, and once launched over stdio; then
// compared with the Python version's server, on the same database, at the same time.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, before, beforeEach, test } from "node:test";
import { connect } from "../ch14/servers.ts";
import { SETTINGS, inventory, manifest } from "../ch15/build_extension.ts";
import { clock, createServer, dayInFull, discreetCustomer, fcfa } from "../ch15/comptoir_for_awa.ts";
import { PYTHON, ROOT } from "../comptoir/launch.ts";
import { pythonAnnouncement, typeScriptAnnouncement } from "./mcp_announcement.ts";

const T0 = new Date("2026-10-21T07:00:00Z");
const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
const DEMO = join(PYTHON, "customer_data", "shop_demo.sqlite3");

/** The Python version's demonstration database, or a database made by its generator, the same draw. */
let template: string | null = null;
before(() => {
  if (existsSync(DEMO)) template = DEMO;
  else if (PYTHON_VENV) {
    template = join(mkdtempSync(join(tmpdir(), "ch15-")), "shop.sqlite3");
    execFileSync(PYTHON_VENV, ["-c", "import sys; from pathlib import Path; from ch14.make_orders import simulate; simulate(Path(sys.argv[1]))", template], { cwd: PYTHON });
  }
});
const withoutDatabase = (): { skip: string } | Record<string, never> => (existsSync(DEMO) || PYTHON_VENV ? {} : { skip: "neither demonstration database nor Python environment" });

let database: string;
const before_ = { ...process.env };
const originalClock = clock.now;
beforeEach(() => {
  if (!template) return;
  // A fresh copy of the shop for each test: the corrections write in it.
  database = join(mkdtempSync(join(tmpdir(), "comptoir-awa-")), "shop.sqlite3");
  copyFileSync(template, database);
  process.env.COMPTOIR_SHOP = database;
  process.env.COMPTOIR_TODAY = "2026-10-17";
  clock.now = () => T0;
});
afterEach(() => {
  for (const key of ["COMPTOIR_SHOP", "COMPTOIR_TODAY"]) {
    if (before_[key] === undefined) delete process.env[key];
    else process.env[key] = before_[key];
  }
  clock.now = originalClock;
});

async function client(): Promise<Client> {
  const [side, other] = InMemoryTransport.createLinkedPair();
  await createServer().connect(side);
  const c = new Client({ name: "test", version: "1.0.0" });
  await c.connect(other);
  return c;
}

type ToolResult = { structuredContent?: Record<string, unknown>; content: { type: string; text: string }[]; isError?: boolean };
async function call(tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const c = await client();
  try {
    return (await c.callTool({ name: tool, arguments: args })) as ToolResult;
  } finally {
    await c.close();
  }
}
const output = async (tool: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await call(tool, args)).structuredContent!;

function read<T>(sql: string): T {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return db.prepare(sql).all() as T;
  } finally {
    db.close();
  }
}
const stockOf = (product: string): number => read<{ quantity: number }[]>(`SELECT quantity FROM stock WHERE product = '${product.replaceAll("'", "''")}'`)[0]!.quantity;

test("the server announces five tools, only one of them destructive", async () => {
  const c = await client();
  const tools = new Map((await c.listTools()).tools.map((t) => [t.name, t]));
  await c.close();
  assert.deepEqual(new Set(tools.keys()), new Set(["orders_of_the_day", "stock", "sales_of_the_week", "prepare_correction", "apply_correction"]));
  assert.deepEqual([...tools].filter(([, t]) => t.annotations?.destructiveHint).map(([n]) => n), ["apply_correction"]);
  assert.deepEqual(tools.get("apply_correction")!._meta, { "anthropic/requiresUserInteraction": true });
  assert.ok(["orders_of_the_day", "stock", "sales_of_the_week"].every((n) => tools.get(n)!.annotations?.readOnlyHint));
  assert.equal(tools.get("prepare_correction")!.annotations?.readOnlyHint, false); // it writes a draft, not the stock
});

test("the orders of the day are those of the database", withoutDatabase(), async () => {
  const r = await output("orders_of_the_day");
  const [expected] = read<{ n: number; total: number }[]>("SELECT COUNT(*) AS n, SUM(total) AS total FROM orders WHERE substr(created_at, 1, 10) = '2026-10-17'");
  assert.deepEqual([r.count, r.total_fcfa], [expected!.n, expected!.total]);
  assert.equal(r.summary, `${expected!.n} orders on Saturday, October 17, 2026, for ${fcfa(expected!.total)}.`);
  // First name and initial only: enough to deliver, without the full name.
  assert.ok((r.orders as { customer: string }[]).every((o) => o.customer.split(" ").length === 2 && o.customer.endsWith(".")));
});

test("the stock flags the shortage", withoutDatabase(), async () => {
  const r = await output("stock");
  const soursop = (r.products as { product: string; state: string }[]).find((p) => p.product === "Soursop juice")!;
  assert.ok(soursop.state === "out_of_stock" && String(r.summary).includes("Out of stock: Soursop juice."));
});

test("the sales of the week go from Monday to Sunday", withoutDatabase(), async () => {
  const r = await output("sales_of_the_week", { a_day_of_the_week: "2026-10-14" });
  assert.deepEqual([r.start, r.end], ["2026-10-12", "2026-10-18"]);
  assert.equal((r.by_product as { product: string; quantity: number }[]).find((p) => p.product === "Bissap juice")!.quantity, 129); // the figure checked in chapter 14
});

test("a correction happens in two steps", withoutDatabase(), async () => {
  const draft = await output("prepare_correction", { product: "Bissap juice", counted_quantity: 32 });
  assert.deepEqual([draft.current_stock, draft.difference], [40, -8]);
  assert.ok(String(draft.to_tell_awa).includes("that is 8 fewer"));
  assert.equal(stockOf("Bissap juice"), 40); // unchanged
  const done = await output("apply_correction", { token: draft.token });
  assert.deepEqual([done.before, done.after], [40, 32]);
  assert.equal(stockOf("Bissap juice"), 32);
  assert.deepEqual(read<{ status: string }[]>("SELECT status FROM stock_corrections").map((l) => l.status), ["applied"]);
  // A token can be used only once.
  const again = await call("apply_correction", { token: draft.token });
  assert.ok(again.isError && again.content[0]!.text.includes("already been used"));
});

test("a token expires after ten minutes", withoutDatabase(), async () => {
  const draft = await output("prepare_correction", { product: "Pineapple juice", counted_quantity: 10 });
  clock.now = () => new Date(T0.getTime() + 11 * 60_000);
  const r = await call("apply_correction", { token: draft.token });
  assert.ok(r.isError && r.content[0]!.text.includes("expired"));
  assert.equal(stockOf("Pineapple juice"), 12);
  assert.deepEqual(read<{ status: string }[]>("SELECT status FROM stock_corrections").map((l) => l.status), ["expired"]);
});

test("a stock that moved in the meantime cancels the correction, without writing anything", withoutDatabase(), async () => {
  const draft = await output("prepare_correction", { product: "Bissap juice", counted_quantity: 32 });
  const db = new DatabaseSync(database);
  db.exec("UPDATE stock SET quantity = 37 WHERE product = 'Bissap juice'"); // a sale in the meantime
  db.close();
  const r = await call("apply_correction", { token: draft.token });
  assert.ok(r.isError && r.content[0]!.text.includes("has changed since the preparation (40 → 37"));
  assert.equal(stockOf("Bissap juice"), 37);
  // Like Python's with db:, the error cancels the whole block: the correction stays “prepared”.
  assert.deepEqual(read<{ status: string }[]>("SELECT status FROM stock_corrections").map((l) => l.status), ["prepared"]);
});

test("the arguments are checked before the code", withoutDatabase(), async () => {
  assert.ok((await call("prepare_correction", { product: "Mango juice", counted_quantity: 3 })).isError);
  assert.ok((await call("prepare_correction", { product: "Bissap juice", counted_quantity: -1 })).isError);
  const tooMuch = await call("prepare_correction", { product: "Bissap juice", counted_quantity: 900 });
  assert.ok(tooMuch.isError && tooMuch.content[0]!.text.includes("too much for an inventory correction"));
});

test("a missing database gives a message that says what to do", async () => {
  process.env.COMPTOIR_SHOP = join(tmpdir(), "missing-ch15.sqlite3");
  const r = await call("stock");
  assert.ok(r.isError && r.content[0]!.text.includes("Check the extension's “Shop database” setting"));
});

test("resources and prompts", withoutDatabase(), async () => {
  const c = await client();
  const catalog = (await c.readResource({ uri: "comptoir://catalog" })).contents[0] as { text: string };
  const order = (await c.readResource({ uri: "comptoir://order/C-0042" })).contents[0] as { text: string };
  const templates = (await c.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
  const review = await c.getPrompt({ name: "evening_review", arguments: { day: "Saturday, October 17" } });
  await c.close();
  assert.ok(catalog.text.includes("- Bissap juice (500 ml bottle): 1,000 FCFA"));
  assert.ok(order.text.startsWith("# Order C-0042"));
  assert.deepEqual(templates, ["comptoir://order/{number}"]);
  const text = (review.messages[0]!.content as { text: string }).text;
  assert.ok(review.messages[0]!.role === "user" && text.includes("for Saturday, October 17") && text.includes("Do not change anything"));
});

test("the server starts over stdio and writes nothing on standard output", withoutDatabase(), async () => {
  // The client reads standard output as JSON-RPC: a console.log would break it.
  const tsx = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const { client: c, protocol } = await connect({
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", "--import", tsx, join(ROOT, "ch15", "comptoir_for_awa.ts")],
    cwd: ROOT,
    env: { COMPTOIR_SHOP: database, COMPTOIR_TODAY: "2026-10-17" },
  });
  try {
    const r = (await c.callTool({ name: "stock", arguments: {} })) as ToolResult;
    assert.equal(protocol, LATEST_PROTOCOL_VERSION); // 2025-11-25 with SDK 1.32.1; 2026-07-28 in Python
    assert.ok(String(r.structuredContent!.summary).startsWith("Out of stock"));
  } finally {
    await c.close();
  }
});

test("the manifest announces exactly what the server exposes", async () => {
  const [tools, prompts] = await inventory();
  const m = manifest(tools, prompts) as { manifest_version: string; server: { type: string; mcp_config: { env: unknown } }; tools: { name: string }[]; prompts: { name: string; arguments: string[]; text: string }[]; user_config: object };
  assert.ok(m.manifest_version === "0.4" && m.server.type === "node");
  assert.deepEqual(m.tools.map((t) => t.name), ["orders_of_the_day", "stock", "sales_of_the_week", "prepare_correction", "apply_correction"]);
  const review = m.prompts.find((p) => p.name === "evening_review")!;
  assert.deepEqual(review.arguments, ["day"]);
  assert.ok(review.text.includes("${arguments.day}"));
  // Each setting is passed to the server, and only through the environment.
  assert.deepEqual(m.server.mcp_config.env, { COMPTOIR_SHOP: "${user_config.shop_database}" });
  assert.deepEqual(Object.keys(m.user_config), Object.keys(SETTINGS));
});

test("formatting for Awa", () => {
  assert.equal(fcfa(329500), "329,500 FCFA");
  assert.equal(dayInFull("2026-11-01"), "Sunday, November 1, 2026");
  assert.equal(discreetCustomer("Larissa Noudéhou"), "Larissa N.");
  assert.equal(discreetCustomer("Awa"), "Awa");
});

// --- The same server as the Python version -------------------------------------------------------

const withoutPython = (): { skip: string } | Record<string, never> => (PYTHON_VENV ? {} : { skip: "Python environment missing" });

test("the same server as the Python version: announcement, tools, resources and prompts", withoutPython(), async () => {
  const c = await client();
  const ts = await typeScriptAnnouncement(c);
  await c.close();
  assert.deepEqual(ts, pythonAnnouncement(PYTHON_VENV!, "from ch15 import comptoir_for_awa as awa", "awa.server"));
});

test("the same answers as the Python version, on the same database, at the same time", withoutPython(), async () => {
  const calls: [string, Record<string, unknown>][] = [
    ["orders_of_the_day", {}],
    ["orders_of_the_day", { day: "2026-10-01" }],
    ["orders_of_the_day", { day: "2026-12-25" }],
    ["stock", {}],
    ["sales_of_the_week", { a_day_of_the_week: "2026-10-14" }],
    ["sales_of_the_week", {}],
    ["sales_of_the_week", { a_day_of_the_week: "2026-07-20" }],
    ["prepare_correction", { product: "Bissap juice", counted_quantity: 32 }],
    ["prepare_correction", { product: "Ginger syrup", counted_quantity: 5 }],
    ["prepare_correction", { product: "Pineapple juice", counted_quantity: 900 }],
    ["apply_correction", { token: "TOKEN-0" }],
    ["apply_correction", { token: "TOKEN-0" }],
    ["apply_correction", { token: "unknown" }],
  ];
  // The tokens are drawn at random: the n-th token returned replaces TOKEN-n, on both sides.
  const ts: unknown[] = [];
  const tokens: string[] = [];
  for (const [name, args] of calls) {
    const real = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" && v.startsWith("TOKEN-") ? tokens[Number(v.slice(6))] : v]));
    const r = await call(name, real);
    if (r.structuredContent?.token) tokens.push(String(r.structuredContent.token));
    ts.push(r.isError ? { error: r.content[0]!.text } : { output: r.structuredContent, text: r.content[0]!.text });
  }
  const c = await client();
  const resources = [(await c.readResource({ uri: "comptoir://catalog" })).contents[0], (await c.readResource({ uri: "comptoir://order/C-0042" })).contents[0]];
  const prompts = [await c.getPrompt({ name: "evening_review", arguments: {} }), await c.getPrompt({ name: "evening_review", arguments: { day: "Saturday" } }), await c.getPrompt({ name: "inventory", arguments: {} })];
  await c.close();
  const corrections = read<unknown[]>("SELECT product, before, after, prepared_at, status, applied_at FROM stock_corrections ORDER BY prepared_at, product");
  const mask = (text: string, list: string[]): string => list.reduce((t, j, i) => t.replaceAll(j, `TOKEN-${i}`), text);
  const tsText = mask(JSON.stringify({ calls: ts, resources, prompts: prompts.map((p) => p.messages), corrections }), tokens);

  const copy = join(mkdtempSync(join(tmpdir(), "comptoir-awa-python-")), "shop.sqlite3");
  copyFileSync(template!, copy);
  const script = `
import asyncio, json, os, sqlite3, sys
from datetime import datetime, timezone
from mcp import Client
from ch15 import comptoir_for_awa as awa
awa._now = lambda: datetime(2026, 10, 21, 7, 0, tzinfo=timezone.utc)
calls = json.load(sys.stdin)
async def main():
    outputs, tokens = [], []
    async with Client(awa.server) as c:
        for name, args in calls:
            args = {k: (tokens[int(v[6:])] if isinstance(v, str) and v.startswith("TOKEN-") else v) for k, v in args.items()}
            r = await c.call_tool(name, args)
            if r.structured_content and r.structured_content.get("token"):
                tokens.append(r.structured_content["token"])
            outputs.append({"error": r.content[0].text} if r.is_error else {"output": r.structured_content, "text": r.content[0].text})
        d = lambda x: x.model_dump(mode="json", by_alias=True, exclude_none=True)
        resources = [d((await c.read_resource(u)).contents[0]) for u in ("comptoir://catalog", "comptoir://order/C-0042")]
        prompts = [[d(m) for m in (await c.get_prompt(n, a)).messages] for n, a in (("evening_review", {}), ("evening_review", {"day": "Saturday"}), ("inventory", {}))]
    db = sqlite3.connect(os.environ["COMPTOIR_SHOP"])
    db.row_factory = sqlite3.Row
    corrections = [dict(l) for l in db.execute("SELECT product, before, after, prepared_at, status, applied_at FROM stock_corrections ORDER BY prepared_at, product")]
    print(json.dumps({"calls": outputs, "resources": resources, "prompts": prompts, "corrections": corrections, "tokens": tokens}, ensure_ascii=False))
asyncio.run(main())`;
  const python = JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script], {
      cwd: PYTHON,
      input: JSON.stringify(calls),
      encoding: "utf8",
      stdio: "pipe", // the Python server's log stays out of the tests' output
      env: { ...process.env, PYTHONIOENCODING: "utf-8", COMPTOIR_SHOP: copy, COMPTOIR_TODAY: "2026-10-17" },
    }),
  ) as { tokens: string[] } & Record<string, unknown>;
  const { tokens: pythonTokens, ...rest } = python;
  assert.equal(tokens.length, pythonTokens.length);
  assert.deepEqual(JSON.parse(tsText), JSON.parse(mask(JSON.stringify(rest), pythonTokens)));
});
