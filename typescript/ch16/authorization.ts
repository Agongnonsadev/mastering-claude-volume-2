// Chapter 16: the Comptoir's OAuth authorization server, for a single person, Awa.
//
// The online MCP server opens its tools only with an access token. This module issues those tokens: it
// implements the “provider” that the MCP SDK expects (OAuthServerProvider); the SDK serves the addresses of
// the OAuth protocol (metadata, /authorize, /token, /register, /revoke), with Express, and checks PKCE.
// What this module adds:
// - a login page, in English, where Awa types her password and sees who is asking for access;
// - an allowlist of callback addresses: the Claude app, and Claude Code on this computer;
// - opaque tokens, of which only the hash is kept, in a SQLite database (nothing in memory: several
//   processes can serve the same tokens);
// - the rotation of refresh tokens, and the revocation of everything if a used one comes back;
// - a block after five wrong passwords in fifteen minutes.
//
// The TypeScript SDK leaves to the provider checks that the Python SDK makes itself: the expiry of the code,
// the callback address at the exchange, the scopes requested. They are here, with the Python SDK's
// messages. It already compares a local callback address without its port (RFC 8252, § 7.3): the Python
// version added it.
//
// For several people or a company, prefer an identity provider (Keycloak, Auth0, Entra…): the SDK then
// checks its tokens, and this module is no longer needed.
//
// Hash Awa's password, to put in COMPTOIR_PASSWORD_HASH; revoke everything:
//     npx tsx ch16/authorization.ts hash
//     npx tsx ch16/authorization.ts disconnect-all customer_data/authorization.sqlite3

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  CustomOAuthError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Request, Response } from "express";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isMain } from "../comptoir/launch.ts";

export const SCOPE = "comptoir";
export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback"; // claude.ai, desktop and mobile apps
export const REQUEST_DURATION = 10 * 60;
export const CODE_DURATION = 5 * 60;
export const ACCESS_DURATION = 60 * 60;
export const REFRESH_DURATION = 30 * 24 * 60 * 60;
export const MAX_ATTEMPTS = 5;
export const ATTEMPT_WINDOW = 15 * 60;

/** secrets.token_urlsafe(n): n random bytes, in URL-safe base64, without “=”. */
const random = (bytes: number): string => randomBytes(bytes).toString("base64url");

// ---------- Password -----------------------------------------------------------------------

/**
 * scrypt, with a random salt: “scrypt:16384:8:1:salt:hash”, the same form as in Python (a hash made by one of
 * the versions is checked by the other). Colons and not “$”: Docker Compose would read “$…” as a variable in a
 * .env file.
 */
export function hashPassword(password: string, salt: Buffer = randomBytes(16)): string {
  const digest = scryptSync(password, salt, 32, { N: 2 ** 14, r: 8, p: 1 });
  return `scrypt:16384:8:1:${salt.toString("base64url")}:${digest.toString("base64url")}`;
}

export function checkPassword(password: string, expected: string): boolean {
  const parts = expected.split(":");
  if (parts.length !== 6) return false;
  const [, n, r, p, salt, digest] = parts as [string, string, string, string, string, string];
  const integer = (s: string): number => (/^\s*[+-]?\d+\s*$/.test(s) ? Number(s) : Number.NaN); // Python's int()
  let computed: Buffer;
  try {
    computed = scryptSync(password, Buffer.from(salt, "base64url"), 32, { N: integer(n), r: integer(r), p: integer(p) });
  } catch {
    return false;
  }
  const wanted = Buffer.from(digest, "base64url");
  return wanted.length === computed.length && timingSafeEqual(computed, wanted);
}

const fingerprint = (token: string): string => createHash("sha256").update(token).digest("hex");

// ---------- Callback addresses -------------------------------------------------------------------

function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

function local(uri: string): boolean {
  const u = parse(uri);
  return u !== null && u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname);
}

/** The Claude app, or a client on this computer (Claude Code, our scripts), any port. */
export function callbackAllowed(uri: string): boolean {
  return uri === CLAUDE_CALLBACK || (local(uri) && parse(uri)!.pathname === "/callback");
}

/** The Python SDK's construct_redirect_uri: the callback address, with its parameters added (without the missing ones). */
function constructCallback(base: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined) u.searchParams.append(key, value);
  return u.href;
}

// ---------- The provider ---------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, info TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, params TEXT NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS codes (fingerprint TEXT PRIMARY KEY, data TEXT NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (fingerprint TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL,
    scopes TEXT NOT NULL, resource TEXT, expires REAL NOT NULL, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS failures (at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS consents (request TEXT PRIMARY KEY, callback TEXT NOT NULL, expires REAL NOT NULL);
`;

/** An authorization request waiting for the password (the fields of AuthorizationParams in Python). */
interface PendingRequest {
  state: string | null;
  scopes: string[] | null;
  code_challenge: string;
  redirect_uri: string;
  redirect_uri_provided_explicitly: boolean;
  resource: string | null;
}

/** An authorization code (the fields of AuthorizationCode in Python). */
interface Code {
  code: string;
  scopes: string[];
  expires_at: number;
  client_id: string;
  code_challenge: string;
  redirect_uri: string;
  redirect_uri_provided_explicitly: boolean;
  resource: string | null;
  subject: string;
}

interface Token {
  fingerprint: string;
  kind: string;
  client_id: string;
  scopes: string;
  resource: string | null;
  expires: number;
  state: string;
}

/** Awa's authorization server, plugged into the MCP SDK (mcpAuthRouter and requireBearerAuth). */
export class AwaProvider implements OAuthServerProvider {
  readonly path: string;
  readonly url: string;
  /** The issuer as the SDK announces it in its metadata (URL.href: a trailing slash for an origin). */
  readonly issuer: string;

  constructor(
    database: string,
    publicUrl: string,
    readonly resource: string,
    readonly passwordHash: string,
    readonly clock: () => number = () => Date.now() / 1000, // in seconds, like time.time
  ) {
    this.path = database;
    this.url = publicUrl.replace(/\/+$/, "");
    this.issuer = new URL(this.url).href;
    this.withDb((db) => db.exec(SCHEMA));
  }

  /** A connection, for the time of a block: its writes together or not at all (Python's with db:). */
  private withDb<T>(work: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.path);
    try {
      db.exec("PRAGMA busy_timeout = 10000");
      db.exec("BEGIN");
      try {
        const result = work(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }

  // --- Clients (dynamic registration, RFC 7591) ---

  private readClient(db: DatabaseSync, clientId: string): OAuthClientInformationFull | undefined {
    const row = db.prepare("SELECT info FROM clients WHERE client_id = ?").get(clientId) as { info: string } | undefined;
    return row ? (JSON.parse(row.info) as OAuthClientInformationFull) : undefined;
  }

  private client(clientId: string): OAuthClientInformationFull | undefined {
    return this.withDb((db) => this.readClient(db, clientId));
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId) => this.client(clientId),
      registerClient: async (client) => this.register(client as OAuthClientInformationFull),
    };
  }

  private register(client: OAuthClientInformationFull): OAuthClientInformationFull {
    // What the Python SDK checks itself (ClientRegistrationOptions: allowed and default scopes).
    const info = { ...client };
    if (info.scope === undefined) info.scope = SCOPE;
    else {
      const refusedScopes = [...new Set(info.scope.split(/\s+/).filter(Boolean))].filter((s) => s !== SCOPE);
      if (refusedScopes.length) throw new InvalidClientMetadataError(`Requested scopes are not valid: ${refusedScopes.join(", ")}`);
    }
    if (info.grant_types && !info.grant_types.includes("authorization_code")) throw new InvalidClientMetadataError("grant_types must include 'authorization_code'");
    if (info.response_types && !info.response_types.includes("code")) throw new InvalidClientMetadataError("response_types must include 'code' for authorization_code grant");
    const refused = info.redirect_uris.filter((u) => !callbackAllowed(u));
    if (refused.length) throw new CustomOAuthError("invalid_redirect_uri", `Callback address refused by this server: ${refused.join(", ")}`);
    this.withDb((db) => db.prepare("INSERT INTO clients VALUES (?, ?, ?)").run(info.client_id, JSON.stringify(info), this.clock()));
    return info;
  }

  // --- Authorization: the login page ---

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // The TypeScript SDK does not tell the provider whether the callback address was in the request: the request does.
    const raw = (res.req.method === "POST" ? res.req.body : res.req.query) as Record<string, unknown>;
    const allowed = (client.scope ?? "").split(" ");
    const requested = params.scopes?.length ? params.scopes : null;
    for (const s of requested ?? []) if (!allowed.includes(s)) throw new InvalidScopeError(`Client was not registered with scope ${s}`);
    if (params.resource && params.resource.href.replace(/\/+$/, "") !== this.resource.replace(/\/+$/, "")) {
      throw new InvalidTargetError("This server issues tokens only for the Comptoir.");
    }
    const pending: PendingRequest = {
      state: params.state ?? null,
      scopes: requested,
      code_challenge: params.codeChallenge,
      redirect_uri: params.redirectUri,
      redirect_uri_provided_explicitly: raw.redirect_uri !== undefined,
      resource: params.resource?.href ?? null,
    };
    const identifier = random(24);
    this.withDb((db) => {
      db.prepare("DELETE FROM requests WHERE expires < ?").run(this.clock());
      db.prepare("INSERT INTO requests VALUES (?, ?, ?, ?)").run(identifier, client.client_id, JSON.stringify(pending), this.clock() + REQUEST_DURATION);
    });
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, `${this.url}/login?request=${identifier}`);
  }

  private blocked(db: DatabaseSync): boolean {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM failures WHERE at > ?").get(this.clock() - ATTEMPT_WINDOW) as { n: number };
    return n >= MAX_ATTEMPTS;
  }

  /** GET: the page; POST: Awa's answer (body already read by express.urlencoded). */
  async loginPage(request: Request, response: Response): Promise<void> {
    const identifier = typeof request.query.request === "string" ? request.query.request : "";
    const page = this.withDb((db): Page => {
      const row = db.prepare("SELECT * FROM requests WHERE id = ? AND expires > ?").get(identifier, this.clock()) as { client_id: string; params: string } | undefined;
      if (!row) {
        // On a connection that drops, the response to the first submission can be lost and the browser submits
        // the form again: the same redirection is returned, without a new code. Harmless: the code works only
        // once, and only for the client that holds the PKCE verifier.
        const consent = db.prepare("SELECT callback FROM consents WHERE request = ? AND expires > ?").get(identifier, this.clock()) as { callback: string } | undefined;
        if (consent) return { redirection: consent.callback };
        return htmlPage("This request has expired", "<p>Go back to Claude and start the connection again.</p>", 400);
      }
      const params = JSON.parse(row.params) as PendingRequest;
      const client = this.readClient(db, row.client_id);
      if (request.method === "GET") return consentPage(identifier, client, params);
      const form = (request.body ?? {}) as Record<string, unknown>;
      if (form.decision === "deny") {
        db.prepare("DELETE FROM requests WHERE id = ?").run(identifier);
        return { redirection: constructCallback(params.redirect_uri, { error: "access_denied", state: params.state, iss: this.issuer }) };
      }
      if (this.blocked(db)) return consentPage(identifier, client, params, "Too many attempts: wait fifteen minutes.", 429);
      if (!checkPassword(String(form.password ?? ""), this.passwordHash)) {
        db.prepare("INSERT INTO failures VALUES (?)").run(this.clock());
        return consentPage(identifier, client, params, "Wrong password.", 401);
      }
      const code = random(32);
      const data: Code = {
        code,
        scopes: params.scopes ?? [SCOPE],
        expires_at: this.clock() + CODE_DURATION,
        client_id: client!.client_id,
        code_challenge: params.code_challenge,
        redirect_uri: params.redirect_uri,
        redirect_uri_provided_explicitly: params.redirect_uri_provided_explicitly,
        resource: params.resource ?? this.resource,
        subject: "awa",
      };
      // RFC 9207: the issuer comes with the code, and the client checks it.
      const callback = constructCallback(params.redirect_uri, { code, state: params.state, iss: this.issuer });
      db.prepare("DELETE FROM requests WHERE id = ?").run(identifier);
      db.prepare("INSERT INTO codes VALUES (?, ?, ?)").run(fingerprint(code), JSON.stringify(data), data.expires_at);
      db.prepare("INSERT INTO consents VALUES (?, ?, ?)").run(identifier, callback, data.expires_at);
      return { redirection: callback };
    });
    if ("redirection" in page) response.redirect(302, page.redirection);
    else response.status(page.status).set(page.headers).type("html").send(page.html);
  }

  // --- Codes and tokens ---

  /** The code, if it exists for this client and has not expired (checked by the Python SDK, here by the provider). */
  private code(client: OAuthClientInformationFull, code: string): Code {
    const row = this.withDb((db) => db.prepare("SELECT data FROM codes WHERE fingerprint = ?").get(fingerprint(code))) as { data: string } | undefined;
    const data = row ? (JSON.parse(row.data) as Code) : null;
    if (!data || data.client_id !== client.client_id) throw new InvalidGrantError("authorization code does not exist");
    if (data.expires_at < Date.now() / 1000) throw new InvalidGrantError("authorization code has expired");
    return data;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.code(client, code).code_challenge;
  }

  private issue(db: DatabaseSync, clientId: string, scopes: string[], resource: string | null): OAuthTokens {
    const access = random(32);
    const refresh = random(32);
    const now = this.clock();
    for (const [token, kind, duration] of [[access, "access", ACCESS_DURATION], [refresh, "refresh", REFRESH_DURATION]] as const) {
      db.prepare("INSERT INTO tokens VALUES (?, ?, ?, ?, ?, ?, 'valid')").run(fingerprint(token), kind, clientId, scopes.join(" "), resource, now + duration);
    }
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_DURATION, scope: scopes.join(" "), refresh_token: refresh };
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const data = this.code(client, code);
    const expected = data.redirect_uri_provided_explicitly ? data.redirect_uri : undefined;
    if (redirectUri !== expected) throw new InvalidRequestError("redirect_uri did not match the one used when creating auth code");
    return this.withDb((db) => {
      const deleted = db.prepare("DELETE FROM codes WHERE fingerprint = ?").run(fingerprint(code));
      if (deleted.changes !== 1) throw new InvalidGrantError("This code has already been used."); // a code works only once
      return this.issue(db, client.client_id, data.scopes, data.resource);
    });
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[]): Promise<OAuthTokens> {
    const verdict = this.withDb((db) => {
      const row = db.prepare("SELECT * FROM tokens WHERE fingerprint = ? AND kind = 'refresh'").get(fingerprint(token)) as Token | undefined;
      if (!row || row.client_id !== client.client_id) return null;
      if (row.state === "used") {
        // A refresh token already exchanged that comes back: it was stolen, or copied. Everything this client
        // holds is revoked (OAuth 2.1, token rotation). Written before refusing.
        db.prepare("UPDATE tokens SET state = 'revoked' WHERE client_id = ?").run(client.client_id);
        return null;
      }
      if (row.state !== "valid" || row.expires < this.clock()) return null;
      return row;
    });
    if (!verdict) throw new InvalidGrantError("refresh token does not exist");
    const its = verdict.scopes.split(" ");
    const wanted = scopes?.length ? scopes : its;
    for (const s of wanted) if (!its.includes(s)) throw new InvalidScopeError(`cannot request scope \`${s}\` not provided by refresh token`);
    return this.withDb((db) => {
      db.prepare("UPDATE tokens SET state = 'used' WHERE fingerprint = ?").run(verdict.fingerprint);
      return this.issue(db, client.client_id, wanted, verdict.resource);
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.withDb((db) => db.prepare("SELECT * FROM tokens WHERE fingerprint = ? AND kind = 'access'").get(fingerprint(token))) as Token | undefined;
    if (!row || row.state !== "valid" || row.expires < this.clock()) throw new InvalidTokenError("Invalid token");
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes.split(" "),
      expiresAt: Math.trunc(row.expires),
      ...(row.resource ? { resource: new URL(row.resource) } : {}),
      extra: { iss: this.issuer, subject: "awa" },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.withDb((db) => db.prepare("UPDATE tokens SET state = 'revoked' WHERE fingerprint = ? AND client_id = ?").run(fingerprint(request.token), client.client_id));
  }

  /** Revokes all the tokens: to do if Awa's phone is lost. Returns the number revoked. */
  disconnectAll(): number {
    return Number(this.withDb((db) => db.prepare("UPDATE tokens SET state = 'revoked' WHERE state = 'valid'").run().changes));
  }
}

// ---------- The pages ----------------------------------------------------------------------------

const STYLE =
  "body{font-family:system-ui,sans-serif;max-width:30rem;margin:2rem auto;padding:0 1rem;line-height:1.5}" +
  "button{font-size:1rem;padding:.6rem 1rem;margin:.3rem .3rem 0 0}input{font-size:1rem;padding:.5rem;width:100%}" +
  ".alert{background:#fde8e8;padding:.6rem;border-radius:.4rem}.note{background:#fff6dd;padding:.6rem;border-radius:.4rem}";

type Page = { redirection: string } | { html: string; status: number; headers: Record<string, string> };

/** Python's html.escape: with the quotes (attributes), or without (a text between two tags). */
function escape(text: string, quotes = true): string {
  const s = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return quotes ? s.replaceAll('"', "&quot;").replaceAll("'", "&#x27;") : s;
}

function origin(uri: string): string {
  const u = new URL(uri);
  return `${u.protocol}//${u.host}`;
}

function htmlPage(title: string, body: string, status = 200, callback?: string): Page {
  // form-action also applies to the redirection that follows the form submission: without the origin of the
  // callback address, the browser would block the way back to Claude (observed during the Python version's trial).
  const action = "'self'" + (callback ? ` ${origin(callback)}` : "");
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" ` +
    `content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style>` +
    `</head><body><h1>${escape(title)}</h1>${body}</body></html>`;
  return {
    html,
    status,
    headers: { "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${action}` },
  };
}

function consentPage(identifier: string, client: OAuthClientInformationFull | undefined, params: PendingRequest, error = "", status = 200): Page {
  const text = (s: string): string => escape(s, false); // a text between two tags: < > & are enough
  const name = text(client?.client_name || "An application");
  let body =
    `<p><strong>${name}</strong> is asking for access to your Comptoir: read your orders, your stock and ` +
    `your sales, and correct the stock with your consent.</p><p>After your answer, you will come back to ` +
    `<strong>${text(parse(params.redirect_uri)?.hostname ?? "")}</strong>.</p>`;
  if (local(params.redirect_uri)) {
    body += '<p class="note">The return happens on this computer. Accept only if you have just started the connection yourself, for example from Claude Code.</p>';
  }
  if (error) body += `<p class="alert">${text(error)}</p>`;
  body +=
    `<form method="post"><input type="hidden" name="request" value="${escape(identifier)}">` +
    '<label>Your Comptoir password<input type="password" name="password" ' +
    'autocomplete="current-password" autofocus></label>' +
    '<button name="decision" value="allow">Allow</button>' +
    '<button name="decision" value="deny">Deny</button></form>';
  return htmlPage("Comptoir for Awa", body, status, params.redirect_uri);
}

// ---------- Administration -------------------------------------------------------------------------

/** getpass.getpass: reads a line without showing it (from the keyboard; from a pipe, as is). */
async function readWithoutEcho(question: string): Promise<string> {
  process.stderr.write(question);
  const input = process.stdin;
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  }
  input.setRawMode(true);
  return new Promise((resolve) => {
    let typed = "";
    const read = (chunk: Buffer): void => {
      for (const c of chunk.toString("utf8")) {
        if (c === "\r" || c === "\n") {
          input.setRawMode(false);
          input.off("data", read);
          input.pause();
          process.stderr.write("\n");
          resolve(typed);
          return;
        }
        if (c === "\u0003") process.exit(130); // Ctrl+C
        typed = c === "\u007f" || c === "\b" ? typed.slice(0, -1) : typed + c;
      }
    };
    input.on("data", read);
    input.resume();
  });
}

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "hash") {
    const password = await readWithoutEcho("Awa's password (it is not displayed): ");
    if ([...password].length < 12) stop("At least 12 characters.");
    console.log(hashPassword(password));
  } else if (args[0] === "disconnect-all" && args.length === 2) {
    // Phone lost, password changed: every application will have to log in again.
    const database = args[1]!;
    if (!existsSync(database) || !statSync(database).isFile()) stop(`Database not found: ${database}`);
    const db = new DatabaseSync(database);
    try {
      const n = db.prepare("UPDATE tokens SET state = 'revoked' WHERE state = 'valid'").run().changes;
      console.log(`${n} token(s) revoked.`);
    } finally {
      db.close();
    }
  } else {
    stop("Usage: npx tsx ch16/authorization.ts hash\n       npx tsx ch16/authorization.ts disconnect-all <token database>");
  }
}

if (isMain(import.meta.url)) await main();
