// Chapter 16: log in to the online Comptoir the way an MCP client does, OAuth included.
//
// Run, from the typescript/ folder, with the server running (see online_server.ts):
//     npx tsx ch16/connect.ts http://localhost:8016/mcp               # with your browser
//     npx tsx ch16/connect.ts http://localhost:8016/mcp --automatic   # local trial, without a browser
//
// What the client does, in order: it calls /mcp without a token and receives a 401 that points to the
// resource's metadata; it reads there the address of the authorization server; it registers (dynamic
// registration); it opens the login page, with a PKCE challenge; it receives a code at its callback address;
// it exchanges it for a token; it calls /mcp again with this token. The SDK does all of this: this script
// provides the browser, the callback address and the tokens file. The TypeScript SDK hands control back
// between the page and the exchange (UnauthorizedError, then finishAuth with the code); it checks neither
// the state nor the issuer returned with the code, which the Python SDK checks: this script does it.
//
// --automatic replaces the browser with a request that fills in the login page with the password of
// COMPTOIR_TEST_PASSWORD: for a test server, on your computer, only. The tokens are kept in
// customer_data/client_tokens.json (excluded from Git).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { ROOT, isMain } from "../comptoir/launch.ts";
import { SCOPE } from "./authorization.ts";

export const TOKENS = join(ROOT, "customer_data", "client_tokens.json");
export const CALLBACK_PORT = 3030;

/** The tokens and the client's registration, in a file: the next connection is silent. */
export class FileStorage {
  constructor(readonly path = TOKENS) {}

  private read(): Record<string, unknown> {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>) : {};
  }

  private write(key: string, value: unknown): void {
    const data = { ...this.read(), [key]: value };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data, null, 2), "utf8");
  }

  tokens = (): OAuthTokens | undefined => this.read().tokens as OAuthTokens | undefined;
  keepTokens = (tokens: OAuthTokens): void => this.write("tokens", tokens);
  client = (): OAuthClientInformationMixed | undefined => this.read().client as OAuthClientInformationMixed | undefined;
  keepClient = (client: OAuthClientInformationMixed): void => this.write("client", client);
}

/** What the callback address receives: the code, the state and the issuer (RFC 9207). */
export interface CallbackResult {
  code: string;
  state: string | null;
  iss: string | null;
}

export function callbackResult(address: string): CallbackResult {
  const params = new URL(address, "http://localhost").searchParams;
  if (params.has("error")) stop(`Connection refused: ${params.get("error")}`);
  return { code: params.get("code")!, state: params.get("state"), iss: params.get("iss") };
}

export interface Browser {
  open: (address: URL) => Promise<void>;
  wait: () => Promise<CallbackResult>;
}

/** What Awa's browser would do: follow /authorize, fill in the page, bring back the callback address. */
export function simulatedBrowser(password: string): Browser {
  let deliver: (r: CallbackResult) => void = () => {};
  const callback = new Promise<CallbackResult>((ok) => (deliver = ok));
  return {
    open: async (address) => {
      const get = (url: string, init: RequestInit = {}): Promise<Response> => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), ...init });
      let url = address.href;
      let response = await get(url);
      while ((response.status === 302 || response.status === 307) && !url.includes("/login")) {
        url = new URL(response.headers.get("location")!, url).href;
        response = await get(url);
      }
      if (!(await response.text()).includes("Comptoir for Awa")) throw new Error("login page expected");
      const sent = await get(url, { method: "POST", body: new URLSearchParams({ password, decision: "allow" }) });
      if (sent.status !== 302) stop(`Connection refused by the page (${sent.status}): ` + [...(await sent.text()).replace(/<[^>]+>/g, " ")].slice(-200).join(""));
      deliver(callbackResult(sent.headers.get("location")!));
    },
    wait: () => callback,
  };
}

/** Opens an address in the computer's browser (Python's webbrowser.open). */
function openInTheBrowser(address: string): void {
  const [command, args] = process.platform === "win32" ? ["explorer.exe", [address]] : process.platform === "darwin" ? ["open", [address]] : ["xdg-open", [address]];
  spawn(command, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

/** Opens the browser, and waits for the return on http://localhost:3030/callback. */
export function realBrowser(): Browser {
  let deliver: (r: CallbackResult) => void = () => {};
  const callback = new Promise<CallbackResult>((ok) => (deliver = ok));
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<p>Done: you can close this page.</p>");
    server.close();
    deliver(callbackResult(request.url ?? "/"));
  });
  return {
    open: async (address) => {
      await new Promise<void>((ok) => server.listen(CALLBACK_PORT, "127.0.0.1", ok));
      console.log(`Open this page if the browser does not open: ${address.href}`);
      openInTheBrowser(address.href);
    },
    wait: () => callback,
  };
}

/** What the SDK asks of the client: its identity, where to keep its tokens, how to open the page. */
export class OAuthConnection implements OAuthClientProvider {
  private verifier = "";
  readonly sentState = randomBytes(16).toString("base64url");
  issuer: string | null = null;

  constructor(
    readonly storage: FileStorage,
    readonly browser: Browser,
  ) {}

  get redirectUrl(): string {
    return `http://localhost:${CALLBACK_PORT}/callback`;
  }

  get clientMetadata() {
    return { client_name: "Yao's script", scope: SCOPE, redirect_uris: [this.redirectUrl], token_endpoint_auth_method: "none" };
  }

  state = (): string => this.sentState;
  clientInformation = (): OAuthClientInformationMixed | undefined => this.storage.client();
  saveClientInformation = (client: OAuthClientInformationMixed): void => this.storage.keepClient(client);
  tokens = (): OAuthTokens | undefined => this.storage.tokens();
  saveTokens = (tokens: OAuthTokens): void => this.storage.keepTokens(tokens);
  redirectToAuthorization = (address: URL): Promise<void> => this.browser.open(address);
  saveCodeVerifier = (verifier: string): void => void (this.verifier = verifier);
  codeVerifier = (): string => this.verifier;
  saveDiscoveryState = (discovery: { authorizationServerMetadata?: { issuer: string } }): void => void (this.issuer = discovery.authorizationServerMetadata?.issuer ?? null);

  /** The code, after checking the state (the same as the one sent) and the issuer (that of the metadata). */
  async code(): Promise<string> {
    const callback = await this.browser.wait();
    if (callback.state !== this.sentState) stop("Connection refused: the state returned is not the request's.");
    if (callback.iss !== null && callback.iss !== this.issuer) stop(`Connection refused: unexpected issuer (${callback.iss}).`);
    return callback.code;
  }
}

/** The confirmation form, in the console: this is where Awa would say yes. */
async function accept(message: string): Promise<ElicitResult> {
  console.log(`\n[server form] ${message}`);
  let answer = process.env.COMPTOIR_FORM_ANSWER;
  if (!answer) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    answer = (await terminal.question("Confirm? (y/n) ")).trim().toLowerCase();
    terminal.close();
  }
  console.log(`[answer] ${answer}`);
  return { action: "accept", content: { confirmed: answer === "y" } };
}

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Connects, going through the login page if the file has no (or no longer a) valid token. */
export async function connect(address: string, oauth: OAuthConnection): Promise<[Client, StreamableHTTPClientTransport]> {
  // The form, announced to the server; without a session, it will not know it (see online_server.ts).
  const client = new Client({ name: "yao-script", version: "0.1" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async (r) => accept(r.params.message));
  for (let attempt = 0; ; attempt++) {
    const transport = new StreamableHTTPClientTransport(new URL(address), { authProvider: oauth });
    try {
      await client.connect(transport);
      return [client, transport];
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || attempt > 0) throw error;
      await transport.finishAuth(await oauth.code());
    }
  }
}

async function main(): Promise<void> {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      automatic: { type: "boolean", default: false },
      product: { type: "string", default: "Bissap juice" },
      count: { type: "string", default: "38" },
    },
  });
  const address = positionals[0];
  if (positionals.length !== 1 || !address) stop("Usage: npx tsx ch16/connect.ts <address>/mcp [--automatic] [--product P] [--count N]");
  let browser: Browser;
  if (args.automatic) {
    const password = process.env.COMPTOIR_TEST_PASSWORD ?? "";
    // A test server only: your computer, or the test host you name (a tunnel).
    const hosts = new Set(["localhost", "127.0.0.1", process.env.COMPTOIR_TEST_HOST ?? ""].filter(Boolean));
    if (!password || !hosts.has(new URL(address).hostname)) stop("--automatic: only on a test server, with COMPTOIR_TEST_PASSWORD.");
    browser = simulatedBrowser(password);
  } else browser = realBrowser();

  const [client, transport] = await connect(address, new OAuthConnection(new FileStorage(), browser));
  try {
    const server = client.getServerVersion()!;
    console.log(`Connected: ${server.name} ${server.version}, protocol ${transport.protocolVersion}`);
    console.log("Tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
    console.log("Stock:", ((await client.callTool({ name: "stock", arguments: {} })).structuredContent as { summary: string }).summary);
    console.log("Weekly report:");
    const report = await client.callTool({ name: "weekly_report", arguments: { a_day_of_the_week: "2026-10-14" } }, undefined, {
      onprogress: (p) => console.log(`  [${Math.trunc(p.progress)}/${Math.trunc(p.total ?? 0)}] ${p.message}`),
    });
    console.log(" ", (report.structuredContent as { summary: string }).summary);
    const draft = (await client.callTool({ name: "prepare_correction", arguments: { product: args.product, counted_quantity: Number(args.count) } })).structuredContent as {
      to_tell_awa: string;
      token: string;
    };
    console.log("Preparation:", draft.to_tell_awa);
    const done = (await client.callTool({ name: "apply_correction", arguments: { token: draft.token } })) as { isError?: boolean; structuredContent?: { summary: string }; content: { text: string }[] };
    console.log("Application:", done.isError ? done.content[0]!.text : done.structuredContent!.summary);
  } finally {
    await client.close();
  }
}

if (isMain(import.meta.url)) await main();
