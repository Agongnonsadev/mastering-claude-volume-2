// Chapter 16: the online Comptoir and its authorization server (python/tests/test_ch16.py). No call to the
// API: the application listens on a free port of this computer (127.0.0.1), and the tests talk to it over
// HTTP, as a client would; the MCP server is also questioned in memory.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, before, beforeEach, test } from "node:test";
import { clock, createServer as createDesktopServer } from "../ch15/comptoir_for_awa.ts";
import { request as apiRequest } from "../ch16/ask_through_the_api.ts";
import { AwaProvider, CLAUDE_CALLBACK, checkPassword, hashPassword } from "../ch16/authorization.ts";
import { type Browser, FileStorage, OAuthConnection, connect as connectLikeYao, simulatedBrowser } from "../ch16/connect.ts";
import { application, build } from "../ch16/online_server.ts";
import { headers as rawHeaders, message as rawMessage } from "../ch16/raw_client.ts";
import { PYTHON } from "../comptoir/launch.ts";
import { pythonAnnouncement, typeScriptAnnouncement } from "./mcp_announcement.ts";

const PASSWORD = "password-of-the-tests-16"; // a test value, for this local server only
const CALLBACK = "http://localhost:3030/callback";
const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
const DEMO = join(PYTHON, "customer_data", "shop_demo.sqlite3");

let template: string | null = null;
before(() => {
  if (existsSync(DEMO)) template = DEMO;
  else if (PYTHON_VENV) {
    template = join(mkdtempSync(join(tmpdir(), "ch16-")), "shop.sqlite3");
    execFileSync(PYTHON_VENV, ["-c", "import sys; from pathlib import Path; from ch14.make_orders import simulate; simulate(Path(sys.argv[1]))", template], { cwd: PYTHON });
  }
});
const withoutDatabase = (): { skip: string } | Record<string, never> => (existsSync(DEMO) || PYTHON_VENV ? {} : { skip: "neither demonstration database nor Python environment" });

interface Comptoir {
  url: string;
  port: number;
  shop: string;
  authorization: string;
  provider: AwaProvider;
  http: Server;
}

let comptoir: Comptoir;
const before_ = { ...process.env };
const originalClock = clock.now;

beforeEach(async () => {
  const folder = mkdtempSync(join(tmpdir(), "comptoir-online-"));
  const shop = join(folder, "shop.sqlite3");
  if (template) copyFileSync(template, shop);
  process.env.COMPTOIR_SHOP = shop;
  process.env.COMPTOIR_TODAY = "2026-10-17";
  // The port is known only once the server is listening: the application, and its public address, come after.
  const http = createServer();
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  const port = (http.address() as AddressInfo).port;
  const url = `http://localhost:${port}`;
  const authorization = join(folder, "auth.sqlite3");
  const { app, provider } = application(url, authorization, hashPassword(PASSWORD));
  http.on("request", app);
  comptoir = { url, port, shop, authorization, provider, http };
});

afterEach(async () => {
  comptoir.http.closeAllConnections();
  await new Promise((ok) => comptoir.http.close(ok));
  for (const key of ["COMPTOIR_SHOP", "COMPTOIR_TODAY"]) {
    if (before_[key] === undefined) delete process.env[key];
    else process.env[key] = before_[key];
  }
  clock.now = originalClock;
});

const ACCEPT = { Accept: "application/json, text/event-stream" };
const call = (path: string, init: RequestInit = {}): Promise<globalThis.Response> => fetch(new URL(path, comptoir.url), { redirect: "manual", ...init });
const form = (data: Record<string, string>): RequestInit => ({ method: "POST", body: new URLSearchParams(data) });

function pkce(): [string, string] {
  const verifier = randomBytes(48).toString("base64url");
  return [verifier, createHash("sha256").update(verifier).digest("base64url")];
}

const register = (callbacks = [CALLBACK]): Promise<globalThis.Response> =>
  call("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Tests", redirect_uris: callbacks, token_endpoint_auth_method: "none", scope: "comptoir" }),
  });

function authorize(clientId: string, challenge: string, callback = CALLBACK, resource = `${comptoir.url}/mcp`): Promise<globalThis.Response> {
  const params = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: callback, code_challenge: challenge, code_challenge_method: "S256", state: "state-42", scope: "comptoir", resource });
  return call(`/authorize?${params}`);
}

/** Awa's path up to the token. Returns the client's ID and the response of the token endpoint. */
async function logIn(password = PASSWORD): Promise<[string, globalThis.Response]> {
  const clientId = ((await (await register()).json()) as { client_id: string }).client_id;
  const [verifier, challenge] = pkce();
  const page = (await authorize(clientId, challenge)).headers.get("location")!;
  const sent = await call(page, form({ password, decision: "allow" }));
  assert.equal(sent.status, 302, await sent.text());
  const callback = new URL(sent.headers.get("location")!).searchParams;
  // RFC 9207: the issuer, as the metadata announce it (with the trailing slash of URL.href).
  assert.deepEqual([callback.get("state"), callback.get("iss")], ["state-42", `${comptoir.url}/`]);
  const tokens = await call("/token", form({ grant_type: "authorization_code", code: callback.get("code")!, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier, resource: `${comptoir.url}/mcp` }));
  return [clientId, tokens];
}

type Tokens = { access_token: string; refresh_token: string; token_type: string; expires_in: number };

async function mcpClient(access: string, capabilities = {}): Promise<[Client, StreamableHTTPClientTransport]> {
  const transport = new StreamableHTTPClientTransport(new URL(`${comptoir.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${access}` } } });
  const client = new Client({ name: "tests", version: "1.0.0" }, { capabilities });
  await client.connect(transport);
  return [client, transport];
}

test("without a token, the server says where to authenticate", async () => {
  const refusal = await call("/mcp", { method: "POST", headers: { ...ACCEPT, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const resource = (await (await call("/.well-known/oauth-protected-resource/mcp")).json()) as { resource: string; authorization_servers: string[] };
  const server = (await (await call("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
  assert.equal(refusal.status, 401);
  assert.ok(refusal.headers.get("www-authenticate")!.includes(`resource_metadata="${comptoir.url}/.well-known/oauth-protected-resource/mcp"`));
  assert.ok(resource.resource === `${comptoir.url}/mcp` && resource.authorization_servers[0]!.replace(/\/$/, "") === comptoir.url);
  assert.deepEqual([server.issuer, server.code_challenge_methods_supported, server.registration_endpoint], [`${comptoir.url}/`, ["S256"], `${comptoir.url}/register`]);
});

test("a foreign callback address is refused", async () => {
  const foreign = await register(["https://example.invalid/steal"]);
  const claude = await register([CLAUDE_CALLBACK]);
  assert.ok(foreign.status === 400 && ((await foreign.json()) as { error: string }).error === "invalid_redirect_uri");
  assert.equal(claude.status, 201);
});

test("the complete path opens the tools", withoutDatabase(), async () => {
  const tokens = (await (await logIn())[1].json()) as Tokens;
  assert.ok(tokens.token_type.toLowerCase() === "bearer" && tokens.expires_in === 3600 && tokens.refresh_token);
  const [client, transport] = await mcpClient(tokens.access_token);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const stock = (await client.callTool({ name: "stock", arguments: {} })).structuredContent as { summary: string };
    assert.ok(tools.at(-1) === "weekly_report" && tools.length === 6);
    assert.ok(stock.summary.startsWith("Out of stock"));
    assert.equal(transport.protocolVersion, "2025-11-25"); // 2026-07-28 in Python
    assert.equal(transport.sessionId, undefined); // stateless: no session
  } finally {
    await client.close();
  }
});

test("the page shows who is asking and warns about a local return", async () => {
  const clientId = ((await (await register()).json()) as { client_id: string }).client_id;
  const page = await call((await authorize(clientId, pkce()[1])).headers.get("location")!);
  const text = await page.text();
  assert.ok(page.status === 200 && text.includes("<strong>Tests</strong> is asking for access"));
  assert.ok(text.includes("<strong>localhost</strong>") && text.includes("The return happens on this computer"));
  assert.ok(page.headers.get("cache-control") === "no-store" && page.headers.get("x-frame-options") === "DENY");
  // The redirection that follows the form must be allowed by the CSP, and only towards this callback.
  assert.ok(page.headers.get("content-security-policy")!.endsWith("form-action 'self' http://localhost:3030"));
});

test("the port of a local address can change", async () => {
  const clientId = ((await (await register()).json()) as { client_id: string }).client_id;
  const otherPort = await authorize(clientId, pkce()[1], "http://localhost:51234/callback");
  const otherPath = await authorize(clientId, pkce()[1], "http://localhost:51234/elsewhere");
  assert.ok(otherPort.status === 302 && otherPort.headers.get("location")!.includes("/login?request="));
  assert.equal(otherPath.status, 400); // the path, though, must be the same
});

test("a form sent again after success returns the same redirection", async () => {
  // Observed during the Python version's trial: on a connection that drops, the browser submits the form again.
  const clientId = ((await (await register()).json()) as { client_id: string }).client_id;
  const page = (await authorize(clientId, pkce()[1])).headers.get("location")!;
  const first = await call(page, form({ password: PASSWORD, decision: "allow" }));
  const second = await call(page, form({ password: PASSWORD, decision: "allow" }));
  assert.ok(first.status === 302 && second.status === 302);
  assert.equal(first.headers.get("location"), second.headers.get("location")); // the same code, not a second one
});

test("five wrong passwords block the login", async () => {
  const clientId = ((await (await register()).json()) as { client_id: string }).client_id;
  const page = (await authorize(clientId, pkce()[1])).headers.get("location")!;
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await call(page, form({ password: "wrong", decision: "allow" }))).status);
  const blocked = await call(page, form({ password: PASSWORD, decision: "allow" }));
  assert.deepEqual(codes, [401, 401, 401, 401, 401]);
  assert.ok(blocked.status === 429 && (await blocked.text()).includes("Too many attempts"));
});

test("denying returns access_denied", async () => {
  const clientId = ((await (await register()).json()) as { client_id: string }).client_id;
  const page = (await authorize(clientId, pkce()[1])).headers.get("location")!;
  const refusal = await call(page, form({ decision: "deny" }));
  assert.ok(refusal.status === 302 && refusal.headers.get("location")!.includes("error=access_denied"));
});

test("a foreign resource is refused", async () => {
  const clientId = ((await (await register()).json()) as { client_id: string }).client_id;
  const response = await authorize(clientId, pkce()[1], CALLBACK, "https://other.invalid/mcp");
  assert.ok(response.status === 302 && response.headers.get("location")!.includes("error=invalid_target"));
});

test("rotation and theft of a refresh token", async () => {
  const [clientId, tokens] = await logIn();
  const first = (await tokens.json()) as Tokens;
  const renewed = await call("/token", form({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token }));
  const second = (await renewed.json()) as Tokens;
  // The old refresh token comes back: someone copied it. Everything is revoked.
  const theft = await call("/token", form({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token }));
  const after = await call("/mcp", {
    method: "POST",
    headers: { ...ACCEPT, "Content-Type": "application/json", Authorization: `Bearer ${second.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.ok(renewed.status === 200 && second.refresh_token !== first.refresh_token);
  assert.ok(theft.status === 400 && ((await theft.json()) as { error: string }).error === "invalid_grant");
  assert.equal(after.status, 401);
});

test("the tokens are kept only as a hash", async () => {
  const tokens = (await (await logIn())[1].json()) as Tokens;
  const content = readFileSync(comptoir.authorization);
  assert.ok(!content.includes(tokens.access_token) && !content.includes(tokens.refresh_token));
  assert.ok(content.includes(createHash("sha256").update(tokens.access_token).digest("hex")));
});

/** A request with a chosen Host header, which fetch does not allow to change. */
function withHost(host: string, headers: Record<string, string>): Promise<number> {
  return new Promise((ok, fail) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const r = httpRequest({ host: "127.0.0.1", port: comptoir.port, path: "/mcp", method: "POST", headers: { Host: host, "Content-Type": "application/json", ...ACCEPT, ...headers } }, (response) => {
      response.resume();
      ok(response.statusCode!);
    });
    r.on("error", fail);
    r.end(body);
  });
}

test("an unknown host is refused", async () => {
  // Without a token, the request stops at the 401. With a valid token, it is the host list that stops it: the
  // protection against DNS rebinding does not depend on authentication.
  const access = ((await (await logIn())[1].json()) as Tokens).access_token;
  assert.equal(await withHost("comptoir.example.invalid", {}), 401);
  assert.equal(await withHost("comptoir.example.invalid", { Authorization: `Bearer ${access}` }), 421);
  assert.equal(await withHost(`localhost:${comptoir.port}`, { Authorization: `Bearer ${access}`, Origin: "https://elsewhere.invalid" }), 403);
});

test("the health page says only the state and the version", async () => {
  const health = await call("/health");
  assert.deepEqual([health.status, await health.text()], [200, '{"state":"ok","version":"0.1.0"}']);
});

async function inMemory(capabilities = {}, formAnswer?: (question: string) => ElicitResult): Promise<Client> {
  const [side, other] = InMemoryTransport.createLinkedPair();
  await build().connect(side);
  const client = new Client({ name: "tests", version: "1.0.0" }, { capabilities });
  if (formAnswer) client.setRequestHandler(ElicitRequestSchema, async (r) => formAnswer(r.params.message));
  await client.connect(other);
  return client;
}

test("the online server takes up the desktop server", async () => {
  const [side, other] = InMemoryTransport.createLinkedPair();
  await createDesktopServer().connect(side);
  const desktop = new Client({ name: "tests", version: "1.0.0" });
  await desktop.connect(other);
  const online = await inMemory();
  const desktopTools = (await desktop.listTools()).tools;
  const byName = new Map((await online.listTools()).tools.map((t) => [t.name, t]));
  const prompts = (await online.listPrompts()).prompts.map((p) => p.name);
  const templates = (await online.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
  await Promise.all([desktop.close(), online.close()]);
  for (const t of desktopTools) {
    const { _meta: m1, outputSchema: _s1, ...a } = byName.get(t.name)!;
    const { _meta: m2, outputSchema: _s2, ...b } = t;
    assert.deepEqual(a, b);
    assert.equal(m1?.["anthropic/requiresUserInteraction"], m2?.["anthropic/requiresUserInteraction"]);
  }
  assert.deepEqual([prompts, templates], [["evening_review", "inventory"], ["comptoir://order/{number}"]]);
});

test("the report reports its progress", withoutDatabase(), async () => {
  const client = await inMemory();
  const reports: [number, number | undefined, string | undefined][] = [];
  const result = (await client.callTool({ name: "weekly_report", arguments: { a_day_of_the_week: "2026-10-14" } }, undefined, { onprogress: (p) => void reports.push([p.progress, p.total, p.message]) }))
    .structuredContent as { sales: { total_fcfa: number }; by_day: { total_fcfa: number }[] };
  await client.close();
  assert.deepEqual(reports.map(([d]) => d), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(reports.at(-1)![2] === "Report ready" && reports[0]![2]!.startsWith("Monday, October 12, 2026: "));
  assert.equal(result.sales.total_fcfa, result.by_day.reduce((t, d) => t + d.total_fcfa, 0));
});

const bissapStock = (): number => {
  const db = new DatabaseSync(comptoir.shop, { readOnly: true });
  try {
    return (db.prepare("SELECT quantity FROM stock WHERE product = 'Bissap juice'").get() as { quantity: number }).quantity;
  } finally {
    db.close();
  }
};

for (const [answer, expected, message] of [
  [{ action: "accept", content: { confirmed: true } }, 32, null],
  [{ action: "accept", content: { confirmed: false } }, 40, "Awa did not tick the confirmation: the stock has not changed."],
  [{ action: "decline" }, 40, "Correction declined by Awa: the stock has not changed."],
  [{ action: "cancel" }, 40, "Correction cancelled by Awa: the stock has not changed."],
] as [ElicitResult, number, string | null][]) {
  test(`the correction asks for confirmation from the client that can (${answer.action}${answer.content ? ` ${answer.content.confirmed}` : ""})`, withoutDatabase(), async () => {
    const questions: string[] = [];
    const client = await inMemory({ elicitation: { form: {} } }, (question) => (questions.push(question), answer));
    const draft = (await client.callTool({ name: "prepare_correction", arguments: { product: "Bissap juice", counted_quantity: 32 } })).structuredContent as { token: string };
    const result = (await client.callTool({ name: "apply_correction", arguments: { token: draft.token } })) as { isError?: boolean; content: { text: string }[] };
    await client.close();
    assert.deepEqual(questions, ["Correct the stock of Bissap juice: 40 → 32?"]);
    assert.equal(Boolean(result.isError), expected === 40);
    if (message) assert.equal(result.content[0]!.text, `Error executing tool apply_correction: ${message}`);
    assert.equal(bissapStock(), expected);
  });
}

test("without a possible form, the token is enough", withoutDatabase(), async () => {
  const client = await inMemory(); // no form capability: like the Claude app
  const draft = (await client.callTool({ name: "prepare_correction", arguments: { product: "Bissap juice", counted_quantity: 32 } })).structuredContent as { token: string };
  const done = (await client.callTool({ name: "apply_correction", arguments: { token: draft.token } })).structuredContent as { after: number };
  await client.close();
  assert.equal(done.after, 32);
});

test("over stateless HTTP, a client that can show a form receives none: the token is enough", withoutDatabase(), async () => {
  // The third line of the chapter's table: without a session, its capabilities do not reach the server.
  const access = ((await (await logIn())[1].json()) as Tokens).access_token;
  const [client] = await mcpClient(access, { elicitation: { form: {} } });
  let questions = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => (questions++, { action: "decline" }));
  try {
    const draft = (await client.callTool({ name: "prepare_correction", arguments: { product: "Bissap juice", counted_quantity: 32 } })).structuredContent as { token: string };
    const done = (await client.callTool({ name: "apply_correction", arguments: { token: draft.token } })).structuredContent as { after: number };
    assert.deepEqual([questions, done.after, bissapStock()], [0, 32, 32]);
  } finally {
    await client.close();
  }
});

test("disconnectAll revokes every valid token", async () => {
  const access = ((await (await logIn())[1].json()) as Tokens).access_token;
  assert.equal(comptoir.provider.disconnectAll(), 2); // the access and the refresh
  const after = await call("/mcp", { method: "POST", headers: { ...ACCEPT, "Content-Type": "application/json", Authorization: `Bearer ${access}` }, body: "{}" });
  assert.equal(after.status, 401);
});

test("the password hash", () => {
  const h = hashPassword(PASSWORD, Buffer.alloc(16, 7));
  assert.ok(h.startsWith("scrypt:16384:8:1:BwcHBwcHBwcHBwcHBwcHBw:"));
  assert.ok(checkPassword(PASSWORD, h) && !checkPassword("other", h));
  assert.ok(!checkPassword(PASSWORD, "scrypt:16384:8:1:salt") && !checkPassword(PASSWORD, "any:thing:at:all:here:there"));
});

// --- The same server as the Python version -------------------------------------------------------

const withoutPython = (): { skip: string } | Record<string, never> => (PYTHON_VENV ? {} : { skip: "Python environment missing" });
const T0 = new Date("2026-10-21T07:00:00Z");

/** The Python version's online server, in memory, as its tests build it. */
const PYTHON_PREAMBLE = `
import tempfile
from pathlib import Path
from ch16 import online_server
from ch16.authorization import hash_password
application = online_server.application("http://localhost:8016", str(Path(tempfile.mkdtemp()) / "auth.sqlite3"), hash_password("${PASSWORD}"))
server = application.state.server`;

const python = (script: string, input: unknown, env: Record<string, string> = {}): any =>
  JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script], { cwd: PYTHON, input: JSON.stringify(input), encoding: "utf8", stdio: "pipe", env: { ...process.env, PYTHONIOENCODING: "utf-8", ...env } }));

test("the same server as the Python version: announcement, tools, resources and prompts", withoutPython(), async () => {
  const c = await inMemory();
  const ts = await typeScriptAnnouncement(c);
  await c.close();
  assert.deepEqual(ts, pythonAnnouncement(PYTHON_VENV!, PYTHON_PREAMBLE, "server"));
});

test("the same answers as the Python version: report, progress, confirmation form", withoutPython(), async () => {
  clock.now = () => T0;
  // [tool, arguments, answer to the form if it is asked]. The tokens are drawn at random: the n-th returned
  // replaces TOKEN-n, on both sides.
  const calls: [string, Record<string, unknown>, ElicitResult | null][] = [
    ["weekly_report", { a_day_of_the_week: "2026-10-14" }, null],
    ["weekly_report", {}, null],
    ["weekly_report", { a_day_of_the_week: "2026-07-20" }, null],
    ["prepare_correction", { product: "Bissap juice", counted_quantity: 32 }, null],
    ["apply_correction", { token: "TOKEN-0" }, { action: "accept", content: { confirmed: true } }],
    ["prepare_correction", { product: "Pineapple juice", counted_quantity: 10 }, null],
    ["apply_correction", { token: "TOKEN-1" }, { action: "accept", content: { confirmed: false } }],
    ["prepare_correction", { product: "Bissap juice", counted_quantity: 30 }, null],
    ["apply_correction", { token: "TOKEN-2" }, { action: "decline" }],
    ["prepare_correction", { product: "Bissap juice", counted_quantity: 29 }, null],
    ["apply_correction", { token: "TOKEN-3" }, { action: "cancel" }],
    ["apply_correction", { token: "unknown" }, null],
  ];
  const requests: unknown[] = [];
  let next: ElicitResult | null = null;
  const client = await inMemory({ elicitation: { form: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (r) => (requests.push(JSON.parse(JSON.stringify(r.params))), next!));
  const tokens: string[] = [];
  const ts: unknown[] = [];
  for (const [name, args, answer] of calls) {
    next = answer;
    const real = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" && v.startsWith("TOKEN-") ? tokens[Number(v.slice(6))] : v]));
    const progress: unknown[] = [];
    const r = (await client.callTool({ name, arguments: real }, undefined, { onprogress: (p) => void progress.push([p.progress, p.total, p.message]) })) as {
      structuredContent?: Record<string, unknown>;
      content: { text: string }[];
      isError?: boolean;
    };
    if (r.structuredContent?.token) tokens.push(String(r.structuredContent.token));
    ts.push(r.isError ? { error: r.content[0]!.text } : { output: r.structuredContent, text: r.content[0]!.text, progress });
  }
  await client.close();
  const withoutForm = await inMemory();
  const draft = (await withoutForm.callTool({ name: "prepare_correction", arguments: { product: "Pineapple juice", counted_quantity: 11 } })).structuredContent as { token: string };
  tokens.push(String(draft.token));
  ts.push((await withoutForm.callTool({ name: "apply_correction", arguments: { token: draft.token } })).structuredContent);
  await withoutForm.close();
  const db = new DatabaseSync(comptoir.shop, { readOnly: true });
  const stock = db.prepare("SELECT product, quantity FROM stock WHERE product IN ('Bissap juice', 'Pineapple juice') ORDER BY product").all().map((l) => ({ ...l }));
  db.close();

  const copy = join(mkdtempSync(join(tmpdir(), "comptoir-online-python-")), "shop.sqlite3");
  copyFileSync(template!, copy);
  const py = python(
    `
import asyncio, json, os, sqlite3, sys
from datetime import datetime, timezone
from mcp import Client
from mcp.types import ElicitResult
${PYTHON_PREAMBLE}
from ch15 import comptoir_for_awa as awa
awa._now = lambda: datetime(2026, 10, 21, 7, 0, tzinfo=timezone.utc)
calls = json.load(sys.stdin)
async def main():
    outputs, tokens, requests, next_answer = [], [], [], [None]
    async def form(_context, params):
        requests.append(params.model_dump(mode="json", by_alias=True, exclude_none=True))
        return ElicitResult(**next_answer[0])
    async with Client(server, elicitation_callback=form) as c:
        for name, args, answer in calls:
            next_answer[0] = answer
            args = {k: (tokens[int(v[6:])] if isinstance(v, str) and v.startswith("TOKEN-") else v) for k, v in args.items()}
            progress = []
            async def record(done, total, message):
                progress.append([done, total, message])
            r = await c.call_tool(name, args, progress_callback=record)
            if r.structured_content and r.structured_content.get("token"):
                tokens.append(r.structured_content["token"])
            outputs.append({"error": r.content[0].text} if r.is_error else {"output": r.structured_content, "text": r.content[0].text, "progress": progress})
    async with Client(server) as c:
        draft = (await c.call_tool("prepare_correction", {"product": "Pineapple juice", "counted_quantity": 11})).structured_content
        tokens.append(draft["token"])
        outputs.append((await c.call_tool("apply_correction", {"token": draft["token"]})).structured_content)
    db = sqlite3.connect(os.environ["COMPTOIR_SHOP"])
    db.row_factory = sqlite3.Row
    stock = [dict(l) for l in db.execute("SELECT product, quantity FROM stock WHERE product IN ('Bissap juice', 'Pineapple juice') ORDER BY product")]
    print(json.dumps({"calls": outputs, "requests": requests, "stock": stock, "tokens": tokens}, ensure_ascii=False))
asyncio.run(main())`,
    calls,
    { COMPTOIR_SHOP: copy, COMPTOIR_TODAY: "2026-10-17" },
  );
  const mask = (value: unknown, list: string[]): unknown => JSON.parse(list.reduce((t, j, i) => t.replaceAll(j, `TOKEN-${i}`), JSON.stringify(value)));
  // A refusal and a cancellation: the tool's message, in both versions (fixed on the Python side on October 23,
  // 2026; its SDK stopped the call before the tool, with its own message).
  assert.deepEqual([ts[8], ts[10]], [
    { error: "Error executing tool apply_correction: Correction declined by Awa: the stock has not changed." },
    { error: "Error executing tool apply_correction: Correction cancelled by Awa: the stock has not changed." },
  ]);
  assert.deepEqual(mask({ calls: ts, requests, stock }, tokens), mask({ calls: py.calls, requests: py.requests, stock: py.stock }, py.tokens));
});

// The same HTTP path, played against both servers: this one on its port, the Python version's in memory
// (ASGI, like its tests). The variables (“{client}”) take the values of the previous responses.
interface Step {
  name: string;
  method: string;
  path: string;
  json?: unknown;
  form?: Record<string, string>;
  text?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  host?: string;
  keep?: Record<string, string>;
}

const PATH: Step[] = [
  { name: "without a token", method: "POST", path: "/mcp", json: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
  { name: "protected resource", method: "GET", path: "/.well-known/oauth-protected-resource/mcp" },
  { name: "authorization server", method: "GET", path: "/.well-known/oauth-authorization-server" },
  { name: "foreign callback", method: "POST", path: "/register", json: { client_name: "Tests", redirect_uris: ["https://example.invalid/steal"], token_endpoint_auth_method: "none", scope: "comptoir" } },
  { name: "foreign scope", method: "POST", path: "/register", json: { client_name: "Tests", redirect_uris: ["http://localhost:3030/callback"], token_endpoint_auth_method: "none", scope: "comptoir admin" } },
  { name: "Claude callback", method: "POST", path: "/register", json: { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" } },
  { name: "register", method: "POST", path: "/register", json: { client_name: "Tests <&>", redirect_uris: ["http://localhost:3030/callback"], token_endpoint_auth_method: "none", scope: "comptoir" }, keep: { client: "json:client_id" } },
  { name: "authorize", method: "GET", path: "/authorize", query: { response_type: "code", client_id: "{client}", redirect_uri: "http://localhost:3030/callback", code_challenge: "{challenge}", code_challenge_method: "S256", state: "state-42", scope: "comptoir", resource: "{url}/mcp" }, keep: { page: "location" } },
  { name: "page", method: "GET", path: "{page}" },
  { name: "wrong password", method: "POST", path: "{page}", form: { password: "wrong", decision: "allow" } },
  { name: "other port", method: "GET", path: "/authorize", query: { response_type: "code", client_id: "{client}", redirect_uri: "http://localhost:51234/callback", code_challenge: "{challenge}", code_challenge_method: "S256", state: "state-43", scope: "comptoir" }, keep: { page2: "location" } },
  { name: "deny", method: "POST", path: "{page2}", form: { decision: "deny" } },
  { name: "other path", method: "GET", path: "/authorize", query: { response_type: "code", client_id: "{client}", redirect_uri: "http://localhost:51234/elsewhere", code_challenge: "{challenge}", code_challenge_method: "S256", state: "state-44" } },
  { name: "foreign resource", method: "GET", path: "/authorize", query: { response_type: "code", client_id: "{client}", redirect_uri: "http://localhost:3030/callback", code_challenge: "{challenge}", code_challenge_method: "S256", state: "state-45", resource: "https://other.invalid/mcp" } },
  { name: "unregistered scope", method: "GET", path: "/authorize", query: { response_type: "code", client_id: "{client}", redirect_uri: "http://localhost:3030/callback", code_challenge: "{challenge}", code_challenge_method: "S256", state: "state-46", scope: "admin" } },
  { name: "unknown client", method: "GET", path: "/authorize", query: { response_type: "code", client_id: "unknown", redirect_uri: "http://localhost:3030/callback", code_challenge: "{challenge}", code_challenge_method: "S256" } },
  { name: "right password", method: "POST", path: "{page}", form: { password: "password-of-the-tests-16", decision: "allow" }, keep: { callback: "location" } },
  { name: "form sent again", method: "POST", path: "{page}", form: { password: "password-of-the-tests-16", decision: "allow" } },
  { name: "unknown request", method: "GET", path: "/login?request=unknown" },
  { name: "wrong verifier", method: "POST", path: "/token", form: { grant_type: "authorization_code", code: "{callback.code}", redirect_uri: "http://localhost:3030/callback", client_id: "{client}", code_verifier: "another-verifier-another-verifier-another-0123456789" } },
  { name: "without a callback address", method: "POST", path: "/token", form: { grant_type: "authorization_code", code: "{callback.code}", client_id: "{client}", code_verifier: "{verifier}" } },
  { name: "token", method: "POST", path: "/token", form: { grant_type: "authorization_code", code: "{callback.code}", redirect_uri: "http://localhost:3030/callback", client_id: "{client}", code_verifier: "{verifier}", resource: "{url}/mcp" }, keep: { access: "json:access_token", refresh: "json:refresh_token" } },
  { name: "code reused", method: "POST", path: "/token", form: { grant_type: "authorization_code", code: "{callback.code}", redirect_uri: "http://localhost:3030/callback", client_id: "{client}", code_verifier: "{verifier}" } },
  { name: "unknown host without a token", method: "POST", path: "/mcp", host: "comptoir.example.invalid", json: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
  { name: "unknown host", method: "POST", path: "/mcp", host: "comptoir.example.invalid", headers: { Authorization: "Bearer {access}" }, json: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
  { name: "unknown origin", method: "POST", path: "/mcp", headers: { Authorization: "Bearer {access}", Origin: "https://elsewhere.invalid" }, json: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
  { name: "wrong type", method: "POST", path: "/mcp", headers: { Authorization: "Bearer {access}", "Content-Type": "text/plain" }, text: "{}" },
  { name: "refresh scope", method: "POST", path: "/token", form: { grant_type: "refresh_token", client_id: "{client}", refresh_token: "{refresh}", scope: "admin" } },
  { name: "renew", method: "POST", path: "/token", form: { grant_type: "refresh_token", client_id: "{client}", refresh_token: "{refresh}" }, keep: { access2: "json:access_token" } },
  { name: "stolen refresh", method: "POST", path: "/token", form: { grant_type: "refresh_token", client_id: "{client}", refresh_token: "{refresh}" } },
  { name: "after the theft", method: "POST", path: "/mcp", headers: { Authorization: "Bearer {access2}" }, json: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
  { name: "health", method: "GET", path: "/health" },
];

const VERIFIER = "verifier-of-the-trials-of-chapter-16-0123456789abcdef";
const KEPT_HEADERS = ["location", "content-type", "cache-control", "x-frame-options", "content-security-policy", "www-authenticate"];
type StepResponse = { name: string; status: number; headers: Record<string, string>; body: string };

async function play(steps: Step[], variables: Record<string, string>): Promise<StepResponse[]> {
  const fill = <T>(v: T): T => {
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) as T;
    if (typeof v !== "string") return v;
    return v.replace(/\{([a-z0-9]+)(?:\.([a-z_]+))?\}/g, (_, name: string, field?: string) => (field ? new URL(variables[name]!).searchParams.get(field)! : variables[name]!)) as T;
  };
  const output: StepResponse[] = [];
  for (const s of steps) {
    const headers: Record<string, string> = s.path === "/mcp" ? { ...ACCEPT } : {};
    let body: string | undefined;
    if (s.json) [body, headers["Content-Type"]] = [JSON.stringify(s.json), "application/json"];
    if (s.form) [body, headers["Content-Type"]] = [new URLSearchParams(fill(s.form)).toString(), "application/x-www-form-urlencoded"];
    if (s.text !== undefined) body = s.text;
    Object.assign(headers, fill(s.headers ?? {}), { Host: s.host ?? `localhost:${comptoir.port}` });
    const target = new URL(fill(s.path), comptoir.url);
    for (const [k, v] of Object.entries(fill(s.query ?? {}))) target.searchParams.append(k, v);
    const r = await new Promise<StepResponse>((ok, fail) => {
      const q = httpRequest({ host: "127.0.0.1", port: comptoir.port, path: target.pathname + target.search, method: s.method, headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => {
          const kept = Object.fromEntries(KEPT_HEADERS.filter((k) => k in response.headers).map((k) => [k, String(response.headers[k])]));
          ok({ name: s.name, status: response.statusCode!, headers: kept, body: Buffer.concat(chunks).toString("utf8") });
        });
      });
      q.on("error", fail);
      q.end(body);
    });
    output.push(r);
    for (const [name, source] of Object.entries(s.keep ?? {})) variables[name] = source === "location" ? r.headers.location! : (JSON.parse(r.body) as Record<string, string>)[source.slice(5)]!;
  }
  return output;
}

/** The error texts that each SDK writes itself, and not Awa's provider: they differ. */
const SDK_TEXTS = new Set(["without a token", "unknown host without a token", "after the theft", "other path", "unknown client", "wrong verifier"]);

/**
 * What must be identical from one server to the other: the status, the redirection, the page (and its
 * security headers), the text of a transport refusal, the OAuth error code. The random values are masked;
 * the issuer is compared without its trailing slash (the TypeScript SDK announces it with one, URL.href).
 */
function comparable(responses: StepResponse[], variables: Record<string, string>): unknown[] {
  const url = variables.url!;
  const randoms = Object.entries(variables).flatMap(([k, v]): [string, string][] => {
    if (["url", "verifier", "challenge"].includes(k)) return [];
    const raw = ["page", "page2", "callback"].includes(k) ? new URL(v).searchParams.get(k === "callback" ? "code" : "request")! : v;
    return [[k, raw]];
  });
  const sub = (t: string): string => randoms.reduce((s, [k, v]) => s.replaceAll(v, `<${k}>`), t.replaceAll(url, "{url}").replaceAll(encodeURIComponent(url), "{url}"));
  return responses.map((r) => {
    const output: Record<string, unknown> = { name: r.name, status: r.status };
    if (r.headers.location) {
      const u = new URL(sub(r.headers.location).replace("{url}", "http://comptoir"));
      const query = Object.fromEntries([...u.searchParams].sort().map(([k, v]) => [k, k === "iss" ? v.replace(/\/$/, "") : v]));
      output.location = { address: u.origin + u.pathname, query };
    }
    const type = (r.headers["content-type"] ?? "").split(";")[0];
    if (type === "text/html") Object.assign(output, { page: sub(r.body), ...Object.fromEntries(["cache-control", "x-frame-options", "content-security-policy"].map((k) => [k, r.headers[k]])) });
    else if (r.status >= 400 && type === "application/json") {
      const { error, error_description } = JSON.parse(r.body) as { error: string; error_description: string };
      output.error = SDK_TEXTS.has(r.name) ? (r.name === "unknown client" ? "(code specific to each SDK)" : error) : [error, sub(error_description)];
    } else if (r.status >= 400) output.text = r.body;
    else if (type === "application/json") {
      const body = JSON.parse(sub(r.body)) as Record<string, unknown>;
      const keep = (keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter((k) => k in body).map((k) => [k, body[k]]));
      if ("access_token" in body) output.body = { ...keep(["token_type", "expires_in", "scope"]), access_token: /^<access2?>$/.test(String(body.access_token)) };
      else if ("issuer" in body) {
        const fields = ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint", "scopes_supported", "response_types_supported", "grant_types_supported", "code_challenge_methods_supported"];
        output.body = { ...keep(fields), issuer: String(body.issuer).replace(/\/$/, "") };
      } else if ("resource" in body) output.body = { ...keep(["resource", "scopes_supported"]), authorization_servers: (body.authorization_servers as string[]).map((s) => s.replace(/\/$/, "")) };
      else if ("redirect_uris" in body) output.body = keep(["client_name", "redirect_uris", "token_endpoint_auth_method", "scope"]);
      else output.body = body;
    }
    return output;
  });
}

test("the same OAuth path as the Python version, response by response", withoutPython(), async () => {
  const challenge = createHash("sha256").update(VERIFIER).digest("base64url");
  const tsVariables: Record<string, string> = { url: comptoir.url, verifier: VERIFIER, challenge };
  const ts = comparable(await play(PATH, tsVariables), tsVariables);
  const py = python(
    `
import asyncio, json, re, sys
from urllib.parse import parse_qs, urlsplit
import httpx2
${PYTHON_PREAMBLE}
given = json.load(sys.stdin)
variables = {"url": "http://localhost:8016", **given["variables"]}
KEPT = ${JSON.stringify(KEPT_HEADERS)}
def fill(v):
    if isinstance(v, dict):
        return {k: fill(x) for k, x in v.items()}
    if not isinstance(v, str):
        return v
    def one(m):
        value = variables[m.group(1)]
        return parse_qs(urlsplit(value).query)[m.group(2)][0] if m.group(2) else value
    return re.sub(r"\\{([a-z0-9]+)(?:\\.([a-z_]+))?\\}", one, v)
async def main():
    output = []
    async with application.router.lifespan_context(application):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=application), base_url=variables["url"]) as http:
            for s in given["steps"]:
                headers = {"Accept": "application/json, text/event-stream"} if s["path"] == "/mcp" else {}
                headers |= fill(s.get("headers", {}))
                if "host" in s:
                    headers["Host"] = s["host"]
                options = {}
                if "json" in s: options["json"] = s["json"]
                if "form" in s: options["data"] = fill(s["form"])
                if "text" in s: options["content"] = s["text"]
                if "query" in s: options["params"] = fill(s["query"])
                r = await http.request(s["method"], fill(s["path"]), headers=headers, **options)
                output.append({"name": s["name"], "status": r.status_code, "headers": {k: r.headers[k] for k in KEPT if k in r.headers}, "body": r.text})
                for name, source in s.get("keep", {}).items():
                    variables[name] = r.headers["location"] if source == "location" else r.json()[source[5:]]
    print(json.dumps({"responses": output, "variables": variables}, ensure_ascii=False))
asyncio.run(main())`,
    { variables: { verifier: VERIFIER, challenge }, steps: PATH },
  );
  assert.deepEqual(ts, comparable(py.responses, py.variables));
});

// --- Yao's scripts, against both servers -------------------------------------------------------------

/** The simulated browser, which counts the pages opened. */
function counter(): Browser & { pages: number } {
  const b = simulatedBrowser(PASSWORD);
  const c = { pages: 0, open: async (a: URL) => (c.pages++, b.open(a)), wait: b.wait };
  return c;
}

const temporaryStorage = (): FileStorage => new FileStorage(join(mkdtempSync(join(tmpdir(), "tokens-")), "client_tokens.json"));

/** A request of raw_client: the script's message and headers, sent as they are. */
async function raw(address: string, token: string, id: number, method: string, params?: Record<string, unknown>, name?: string, revision?: string) {
  const response = await fetch(address, { method: "POST", headers: rawHeaders(token, method, name, revision), body: JSON.stringify(rawMessage(id, method, params, revision)) });
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  const data = type.startsWith("text/event-stream") ? text.split(/\r?\n/).filter((l) => l.startsWith("data:")).at(-1)!.slice(5) : text;
  return { status: response.status, session: response.headers.get("mcp-session-id"), body: JSON.parse(data) as { result?: Record<string, unknown>; error?: unknown } };
}

test("connect: the SDK's path, then a silent connection with the kept tokens", withoutDatabase(), async () => {
  const storage = temporaryStorage();
  const first = counter();
  const [client, transport] = await connectLikeYao(`${comptoir.url}/mcp`, new OAuthConnection(storage, first));
  const progress: number[] = [];
  const report = await client.callTool({ name: "weekly_report", arguments: { a_day_of_the_week: "2026-10-14" } }, undefined, { onprogress: (p) => void progress.push(p.progress) });
  assert.deepEqual([first.pages, transport.protocolVersion, client.getServerVersion()!.name], [1, "2025-11-25", "comptoir-for-awa"]);
  assert.ok(String((report.structuredContent as { summary: string }).summary).includes("Best day"));
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7, 8]); // the notifications go through the response's stream
  await client.close();
  const second = counter();
  const [again] = await connectLikeYao(`${comptoir.url}/mcp`, new OAuthConnection(storage, second));
  assert.equal((await again.listTools()).tools.length, 6);
  await again.close();
  assert.equal(second.pages, 0); // no page: the file's token is enough
});

test("raw_client: this server speaks the 2025-11-25 revision, without a session, and refuses 2026-07-28", withoutDatabase(), async () => {
  const access = ((await (await logIn())[1].json()) as Tokens).access_token;
  const address = `${comptoir.url}/mcp`;
  const r = "2025-11-25";
  const welcome = await raw(address, access, 1, "initialize", { protocolVersion: r, capabilities: {}, clientInfo: { name: "yao-raw-client", version: "0.1" } }, undefined, r);
  const tools = await raw(address, access, 2, "tools/list", undefined, undefined, r);
  const stock = await raw(address, access, 3, "tools/call", { name: "stock", arguments: {} }, "stock", r);
  assert.deepEqual([welcome.status, welcome.session, (welcome.body.result!.serverInfo as { name: string }).name], [200, null, "comptoir-for-awa"]);
  assert.equal((tools.body.result!.tools as unknown[]).length, 6);
  assert.ok(String((stock.body.result!.structuredContent as { summary: string }).summary).startsWith("Out of stock"));
  assert.equal((await raw(address, access, 4, "server/discover")).status, 400);
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as AddressInfo).port;
  await new Promise((ok) => s.close(ok));
  return port;
}

test("Yao's scripts against the Python version's server, launched by uvicorn on this computer", withoutPython(), async () => {
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const folder = mkdtempSync(join(tmpdir(), "comptoir-python-"));
  copyFileSync(template!, join(folder, "shop.sqlite3"));
  const env = {
    ...process.env,
    COMPTOIR_PUBLIC_URL: url,
    COMPTOIR_SHOP: join(folder, "shop.sqlite3"),
    COMPTOIR_TODAY: "2026-10-17",
    COMPTOIR_AUTHORIZATION: join(folder, "auth.sqlite3"),
    COMPTOIR_PASSWORD_HASH: hashPassword(PASSWORD), // hashed by the TypeScript version, checked by the Python version
  };
  const uvicorn = spawn(PYTHON_VENV!, ["-m", "uvicorn", "ch16.online_server:app", "--port", String(port)], { cwd: PYTHON, env, stdio: "ignore" });
  try {
    for (let i = 0; !(await fetch(`${url}/health`).then((r) => r.ok, () => false)); i++) {
      if (i > 150) throw new Error("the Python server does not answer");
      await new Promise((ok) => setTimeout(ok, 200));
    }
    const storage = temporaryStorage();
    const browser = counter();
    const [client, transport] = await connectLikeYao(`${url}/mcp`, new OAuthConnection(storage, browser));
    const draft = (await client.callTool({ name: "prepare_correction", arguments: { product: "Bissap juice", counted_quantity: 32 } })).structuredContent as { token: string };
    const done = (await client.callTool({ name: "apply_correction", arguments: { token: draft.token } })).structuredContent as { after: number };
    await client.close();
    // The issuer returned with the code (without a trailing slash) is that of the Python server's metadata: checked.
    assert.deepEqual([browser.pages, transport.protocolVersion, done.after], [1, "2025-11-25", 32]);
    const access = (storage.tokens() as { access_token: string }).access_token;
    const discovery = await raw(`${url}/mcp`, access, 1, "server/discover");
    const tools = await raw(`${url}/mcp`, access, 2, "tools/list");
    const stock = await raw(`${url}/mcp`, access, 3, "tools/call", { name: "stock", arguments: {} }, "stock");
    assert.deepEqual([discovery.status, discovery.session, tools.status, (tools.body.result!.tools as unknown[]).length], [200, null, 200, 6]);
    assert.ok(String((stock.body.result!.structuredContent as { summary: string }).summary).startsWith("Out of stock"));
  } finally {
    uvicorn.kill();
  }
});

test("ask_through_the_api: the same request as the Python version, denylist included", withoutPython(), () => {
  const address = "https://comptoir.example.invalid/mcp";
  const script = ["import json, sys", "from ch16.ask_through_the_api import request", "print(json.dumps(request(*json.load(sys.stdin)), ensure_ascii=False))"];
  const py = python(script.join("\n"), [address, "fake-token"]);
  assert.deepEqual(apiRequest(address, "fake-token"), py);
});
