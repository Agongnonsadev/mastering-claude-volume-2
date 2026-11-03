// Chapter 14: the chapter's MCP servers, in one place, each at a pinned version.
//
// The two local servers are those of the Python version, installed once in python/ch14/mcp/ (npm ci), and
// not downloaded by npx at each launch: package-lock.json pins the package and its whole dependency tree,
// and the signatures are checked with npm audit signatures. They are launched from the python/ folder, as
// Claude Code does with python/.mcp.json: the paths are relative to that folder.
//
// The MCP client is the official SDK's (@modelcontextprotocol/sdk). It does not say which protocol version
// was negotiated: it hands it to the transport, and connect() records it on the way.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PYTHON } from "../comptoir/launch.ts";

export const ROOT = PYTHON; // the folder the servers are launched from
export const MODULES = join(ROOT, "ch14", "mcp", "node_modules");

// The entry points, as paths relative to the python/ folder: that is where Claude Code and the scripts
// launch the servers from.
export const DBHUB = "ch14/mcp/node_modules/@bytebase/dbhub/dist/index.js";
export const EVERYTHING = "ch14/mcp/node_modules/@modelcontextprotocol/server-everything/dist/index.js";
export const DOC_CLAUDE = "https://platform.claude.com/docs/mcp"; // the server of Anthropic's documentation

// DBHub on the exploration copy, read-only (see python/ch14/dbhub.toml).
export const DBHUB_ARGUMENTS = [DBHUB, "--transport", "stdio", "--config", "ch14/dbhub.toml"];

export interface StdioParameters {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export const installedVersion = (pkg: string): string =>
  (JSON.parse(readFileSync(join(MODULES, pkg, "package.json"), "utf8")) as { version: string }).version;

/** The server of Awa's orders: a local program, launched by the client, which talks over stdio. */
export const orders = (): StdioParameters => ({ command: "node", args: DBHUB_ARGUMENTS, cwd: ROOT, env: { CLAUDE_PROJECT_DIR: ROOT } });

/**
 * The MCP project's demonstration server: sample tools, resources and prompts. 2.0.0 (October 19, 2026)
 * requires Node 24; 1.0.0 runs on Node 22.
 */
export const everything = (): StdioParameters => ({ command: "node", args: [EVERYTHING, "stdio"], cwd: ROOT });

export const SERVERS: Record<string, () => StdioParameters | string> = { orders, everything, doc: () => DOC_CLAUDE };

export interface Connection {
  client: Client;
  protocol: string | null; // the negotiated protocol version
}

/**
 * An MCP client connected to a server: launched over stdio (its variables are added to the SDK's default
 * environment, as in Python), or reached over HTTP at its address. To close with client.close().
 */
export async function connect(server: StdioParameters | string, name = "comptoir"): Promise<Connection> {
  const transport: Transport =
    typeof server === "string" ? new StreamableHTTPClientTransport(new URL(server)) : new StdioClientTransport(server);
  const connection: Connection = { client: new Client({ name, version: "1.0.0" }), protocol: null };
  const pass = transport.setProtocolVersion?.bind(transport);
  transport.setProtocolVersion = (version: string) => {
    connection.protocol = version;
    pass?.(version);
  };
  await connection.client.connect(transport);
  return connection;
}
