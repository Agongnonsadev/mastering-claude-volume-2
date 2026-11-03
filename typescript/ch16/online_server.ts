// Chapter 16: “Comptoir for Awa” online, in Streamable HTTP, stateless, behind OAuth.
//
// Local run, from the typescript/ folder:
//     COMPTOIR_PUBLIC_URL=http://localhost:8016 COMPTOIR_SHOP=... COMPTOIR_PASSWORD_HASH=... \
//         npx tsx ch16/online_server.ts --port 8016
//
// It is the server of chapter 15, to the character: the tools, the resource, the template and the prompts
// are those of ch15/comptoir_for_awa.ts, declared by the same code (register). What changes:
// - the transport: HTTP instead of stdio, to be reached from Awa's phone;
// - the access: an OAuth token (ch16/authorization.ts), issued after Awa's password; the OAuth addresses are
//   the MCP SDK's, served by Express;
// - a long-running tool, weekly_report, which sends progress notifications;
// - apply_correction also asks for a confirmation through a form from the client that can show it, and
//   relies on the preparation token for the others, like the Claude app;
// - stateless: no session, the tokens and the corrections are in SQLite databases; several processes can
//   serve the same clients. Each request has its own fresh MCP server.
//
// The TypeScript SDK 1.32.1 stops at the 2025-11-25 revision of the protocol: without a session, the server
// does not know the client's capabilities, and the token is enough (the form in several round trips of the
// 2026-07-28 revision, which the Python version offers, does not exist here). The form remains possible with
// a client that keeps the same server, like the tests' one, in memory.
//
// Configuration (environment variables):
//   COMPTOIR_PUBLIC_URL        the public address, in https:// online (http://localhost:… locally)
//   COMPTOIR_SHOP              the shop's database (SQLite)
//   COMPTOIR_AUTHORIZATION     the token database (default customer_data/authorization.sqlite3)
//   COMPTOIR_PASSWORD_HASH     output of “npx tsx ch16/authorization.ts hash”
//   COMPTOIR_EXTRA_HOSTS       other accepted host names, separated by commas (optional)

import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ElicitResultSchema, type ServerNotification, type ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import * as awa from "../ch15/comptoir_for_awa.ts";
import { INSTRUCTIONS as DESKTOP_INSTRUCTIONS, TOOLS } from "../ch15/schemas.ts";
import { addDays, mondayOf, readDate } from "../comptoir/dates.ts";
import { isMain } from "../comptoir/launch.ts";
import { AwaProvider, SCOPE } from "./authorization.ts";
import { CONFIRMATION, REPORT } from "./schemas.ts";

let log: ((message: string) => void) | null = null;

export const INSTRUCTIONS =
  DESKTOP_INSTRUCTIONS +
  "\n5. For a complete weekly report (day by day, neighborhoods, comparison), use " +
  "weekly_report: it takes a few seconds and reports its progress.";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * “yes” if the correction can be made, otherwise the reason for the refusal. The form, if the client can show
 * it; otherwise, the token is enough: consent was given in the conversation, on the announced difference.
 */
async function confirm(server: McpServer, token: string, extra: Extra): Promise<string> {
  const capabilities = server.server.getClientCapabilities();
  const protocol = extra.requestInfo?.headers["mcp-protocol-version"] ?? "-";
  log?.(`confirmation: protocol ${protocol}, form possible: ${capabilities?.elicitation ? "True" : "False"}`);
  if (!capabilities?.elicitation) return "yes";
  const line = awa.withTheDatabase((db) => {
    db.exec(awa.CORRECTIONS_TABLE);
    return db.prepare("SELECT product, before, after FROM stock_corrections WHERE token = ?").get(token.trim()) as { product: string; before: number; after: number } | undefined;
  });
  if (!line) return "yes"; // apply() will refuse the token, with its own message
  const answer = await extra.sendRequest(
    { method: "elicitation/create", params: { mode: "form", message: `Correct the stock of ${line.product}: ${line.before} → ${line.after}?`, requestedSchema: CONFIRMATION as never } },
    ElicitResultSchema,
  );
  if (answer.action === "decline") return "Correction declined by Awa: the stock has not changed.";
  if (answer.action === "cancel") return "Correction cancelled by Awa: the stock has not changed.";
  if (answer.content?.confirmed !== true) return "Awa did not tick the confirmation: the stock has not changed.";
  return "yes";
}

/** The report of a week, reporting its progress: one day, one notification. */
async function report(aDayOfTheWeek: string | null | undefined, extra: Extra): Promise<Record<string, unknown>> {
  const notify = async (done: number, message: string): Promise<void> => {
    const token = extra._meta?.progressToken;
    if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: done, total: 8, message } });
  };
  const aDay = aDayOfTheWeek ? readDate(aDayOfTheWeek)! : awa.today();
  const monday = mondayOf(aDay);
  const { sales, orders } = awa.withTheDatabase((db) => ({ sales: awa.readSalesOfTheWeek(db, awa.catalog(), aDay), orders: awa.orders(db) }));
  const byDay: { day: string; orders: number; total_fcfa: number }[] = [];
  const neighborhoods = new Map<string, number>();
  for (let i = 0; i < 7; i++) {
    const day = addDays(monday, i);
    const ofTheDay = orders.filter((o) => o.when.day === day);
    for (const o of ofTheDay) neighborhoods.set(o.neighborhood, (neighborhoods.get(o.neighborhood) ?? 0) + o.total);
    byDay.push({ day, orders: ofTheDay.length, total_fcfa: ofTheDay.reduce((t, o) => t + o.total, 0) });
    await notify(i + 1, `${awa.dayInFull(day)}: ${ofTheDay.length} order${ofTheDay.length > 1 ? "s" : ""}`);
  }
  // From the highest to the lowest; at equal amounts, the order of appearance (the sort is stable, as in Python).
  const byNeighborhood = Object.fromEntries([...neighborhoods].sort((a, b) => b[1] - a[1]));
  await notify(8, "Report ready");
  const best = byDay.reduce((m, d) => (d.total_fcfa > m.total_fcfa ? d : m)); // the first of the best, like max()
  const summary =
    `${sales.summary} Best day: ${awa.dayInFull(best.day)} (${awa.fcfa(best.total_fcfa)}). ` +
    `Top neighborhood: ${Object.keys(byNeighborhood)[0] ?? "—"}.`;
  return { sales, by_day: byDay, by_neighborhood: byNeighborhood, summary };
}

/** The online MCP server: that of chapter 15, apply_correction with confirmation, and the report. */
export function build(): McpServer {
  const server = new McpServer({ name: "comptoir-for-awa", title: "Comptoir for Awa", version: awa.VERSION }, { instructions: INSTRUCTIONS });
  awa.register(server, ["apply_correction"]); // redefined here, with the confirmation

  const apply = TOOLS.apply_correction;
  server.registerTool(
    "apply_correction",
    {
      title: apply.title,
      description: apply.description,
      inputSchema: z.fromJSONSchema(apply.input as never) as z.ZodObject,
      outputSchema: z.fromJSONSchema(apply.output as never) as z.ZodObject,
      annotations: apply.annotations,
      _meta: apply._meta,
    },
    (async ({ token }: { token: string }, extra: Extra) =>
      awa.execute("apply_correction", async () => {
        const consent = await confirm(server, token, extra);
        if (consent !== "yes") throw new awa.ToolFailure(consent);
        return awa.withTheDatabase((db) => awa.apply(db, token, awa.clock.now()));
      })) as never,
  );

  server.registerTool(
    "weekly_report",
    {
      title: REPORT.title,
      description: REPORT.description,
      inputSchema: z.fromJSONSchema(REPORT.input as never) as z.ZodObject,
      outputSchema: z.fromJSONSchema(REPORT.output as never) as z.ZodObject,
      annotations: REPORT.annotations,
    },
    (async ({ a_day_of_the_week }: { a_day_of_the_week?: string | null }, extra: Extra) =>
      awa.execute("weekly_report", () => report(a_day_of_the_week, extra))) as never,
  );
  return server;
}

// ---------- The HTTP application -------------------------------------------------------------------

export interface Security {
  hosts: string[];
  origins: string[];
}

/** The accepted host names: the public address's, and those added (a trial tunnel). */
export function security(publicUrl: string): Security {
  const extra = (process.env.COMPTOIR_EXTRA_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const hosts = [new URL(publicUrl).hostname, ...extra];
  return { hosts: hosts.flatMap((h) => [h, `${h}:*`]), origins: ["https://claude.ai"] };
}

/** An allowed name, up to the port if it ends with “:*” (the Python SDK's TransportSecuritySettings). */
function allowed(value: string, permitted: string[]): boolean {
  return permitted.some((p) => value === p || (p.endsWith(":*") && value.startsWith(`${p.slice(0, -2)}:`)));
}

/**
 * The protection against DNS rebinding, on /mcp, after authentication: the same checks and the same
 * responses as the Python SDK's transport (the TypeScript SDK leaves this check to the application).
 */
function transportCheck({ hosts, origins }: Security) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // The reason appears only in the server's log, as in Python.
    const refuse = (status: number, message: string, value: string): void => {
      log?.(`${message}: ${value}`);
      res.status(status).type("text/plain").send(message);
    };
    const type = req.headers["content-type"] ?? "";
    if (req.method === "POST" && !type.toLowerCase().startsWith("application/json")) return refuse(400, "Invalid Content-Type header", type);
    const host = req.headers.host ?? "";
    if (!allowed(host, hosts)) return refuse(421, "Invalid Host header", host);
    const origin = req.headers.origin;
    if (origin && !allowed(origin, origins)) return refuse(403, "Invalid Origin header", origin);
    next();
  };
}

/** One line per MCP request: the method, the protocol revision, the client. Never the token. */
function accessLog(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/mcp") {
    res.on("finish", () => {
      const client = String(req.headers["user-agent"] ?? "-").slice(0, 60);
      log?.(`mcp ${req.method} ${req.headers["mcp-method"] ?? "-"} protocol=${req.headers["mcp-protocol-version"] ?? "-"} client=${client} -> ${res.statusCode}`);
    });
  }
  next();
}

export function application(publicUrl: string, authorizationPath: string, passwordHash: string): { app: Express; provider: AwaProvider } {
  const url = publicUrl.replace(/\/+$/, "");
  const resource = `${url}/mcp`;
  const provider = new AwaProvider(authorizationPath, url, resource, passwordHash);
  const app = express();
  app.disable("x-powered-by");
  app.use(accessLog);
  // The SDK's OAuth addresses: metadata (RFC 8414 and RFC 9728), /authorize, /token, /register, /revoke.
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(url), resourceServerUrl: new URL(resource), scopesSupported: [SCOPE] }));
  app.all("/login", express.urlencoded({ extended: false }), async (req, res) => {
    if (req.method !== "GET" && req.method !== "POST") res.status(405).set("Allow", "GET, POST").send("Method Not Allowed");
    else await provider.loginPage(req, res);
  });
  // Never authenticated: say nothing here that is not public.
  app.get("/health", (_req, res) => {
    res.json({ state: "ok", version: awa.VERSION });
  });
  const authentication = requireBearerAuth({
    verifier: provider,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(resource)),
    expectedResource: new URL(resource), // the Python version's validate_token_resource
  });
  app.all("/mcp", authentication, transportCheck(security(url)), express.json({ limit: "4mb" }), async (req, res) => {
    // Stateless: a fresh server and transport for each request, like stateless_http=True in Python.
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  return { app, provider };
}

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8016" },
      // Behind Caddy, which terminates HTTPS: trust its X-Forwarded-For header (one proxy).
      "behind-a-proxy": { type: "boolean", default: false },
    },
  });
  const url = (process.env.COMPTOIR_PUBLIC_URL ?? "").trim();
  const passwordHash = (process.env.COMPTOIR_PASSWORD_HASH ?? "").trim();
  if (!url || !passwordHash) stop("Set COMPTOIR_PUBLIC_URL and COMPTOIR_PASSWORD_HASH (see the header of ch16/online_server.ts).");
  log = awa.logOnStandardError("comptoir_online");
  awa.plugLog(awa.logOnStandardError("comptoir_for_awa"));
  const authorization = process.env.COMPTOIR_AUTHORIZATION ?? "customer_data/authorization.sqlite3";
  mkdirSync(dirname(authorization), { recursive: true });
  const { app } = application(url, authorization, passwordHash);
  if (args["behind-a-proxy"]) app.set("trust proxy", 1);
  const port = Number(args.port);
  app.listen(port, args.host, () => log?.(`listening on http://${args.host}:${port} (public address: ${url})`));
}

if (isMain(import.meta.url)) await main();
