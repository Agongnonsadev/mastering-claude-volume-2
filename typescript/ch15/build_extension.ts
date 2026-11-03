// Chapter 15: makes the “Comptoir for Awa” desktop extension (.mcpb) from the server.
//
// Run, from the typescript/ folder (free):
//     npx tsx ch15/build_extension.ts             # prepares ch15/build/comptoir-for-awa/
//     npx tsx ch15/build_extension.ts --package   # then validates and packages it with mcpb
//
// The manifest is written by the code, from the server itself: the list of tools and prompts it announces
// cannot diverge from what the server exposes. The package is of type “node”: the Claude app launches the
// server with the Node it ships (mcpb documentation). esbuild makes it a single file, MCP SDK and Zod
// included: nothing else to install. The server reads the database with node:sqlite, which requires Node
// 22.13 or later: the manifest declares it. For --package, you need the tools of the Python version,
// python/ch15/tools (npm ci): the mcpb CLI is there at a pinned version.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { PYTHON, ROOT, isMain } from "../comptoir/launch.ts";
import { pythonJson, splitWords } from "../comptoir/python.ts";
import { VERSION, createServer } from "./comptoir_for_awa.ts";

export const NAME = "comptoir-for-awa";
export const BUILD = join(ROOT, "ch15", "build");
export const FOLDER = join(BUILD, NAME);
export const MCPB = join(PYTHON, "ch15", "tools", "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
export const MINIMUM_NODE = ">=22.13.0"; // node:sqlite without an option

export const SETTINGS = {
  shop_database: {
    type: "file",
    title: "Shop database",
    description: "The shop file that Yao gave you (shop.sqlite3). It stays on your computer: the extension reads it, and changes only the stock in it, after your consent.",
    required: true,
  },
};

const firstSentence = (text: string | undefined): string => `${splitWords(text ?? "").join(" ").split(". ")[0]!.replace(/\.+$/, "")}.`;

export interface AnnouncedTool {
  name: string;
  description: string;
}
export interface AnnouncedPrompt extends AnnouncedTool {
  arguments: string[];
  text: string;
}

/** The tools and the prompts as the server announces them, read by an in-memory MCP client. */
export async function inventory(): Promise<[AnnouncedTool[], AnnouncedPrompt[]]> {
  const [side, other] = InMemoryTransport.createLinkedPair();
  await createServer().connect(side);
  const client = new Client({ name: "build-extension", version: "1.0.0" });
  await client.connect(other);
  try {
    const tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: firstSentence(t.description) }));
    const prompts: AnnouncedPrompt[] = [];
    for (const p of (await client.listPrompts()).prompts) {
      const args = (p.arguments ?? []).map((a) => a.name);
      const rendered = await client.getPrompt({ name: p.name, arguments: Object.fromEntries(args.map((a) => [a, `\${arguments.${a}}`])) });
      const content = rendered.messages[0]!.content as { text: string };
      prompts.push({ name: p.name, description: firstSentence(p.description), arguments: args, text: content.text });
    }
    return [tools, prompts];
  } finally {
    await client.close();
  }
}

export function manifest(tools: AnnouncedTool[], prompts: AnnouncedPrompt[]): Record<string, unknown> {
  return {
    manifest_version: "0.4",
    name: NAME,
    display_name: "Comptoir for Awa",
    version: VERSION,
    description: "Your orders, your stock and your sales of the week, in Claude.",
    long_description:
      "Comptoir for Awa connects Claude to the Délices d'Awa shop. Ask for your orders of the day, " +
      "your stock or your sales of the week. After an inventory, Claude can correct the stock, " +
      "but only after showing you the difference and getting your consent. No other data is " +
      "changed. Example from the book “Mastering Claude”, Volume 2 (Botlyx Academy): fictional " +
      "business and people.",
    author: { name: "Botlyx Academy", url: "https://academy.botlyx.com" },
    icon: "icon.png",
    server: {
      type: "node",
      entry_point: "server/index.mjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/index.mjs"],
        env: { COMPTOIR_SHOP: "${user_config.shop_database}" },
      },
    },
    tools,
    prompts,
    user_config: SETTINGS,
    keywords: ["orders", "stock", "sales", "botlyx"],
    license: "MIT",
    compatibility: { platforms: ["darwin", "win32"], runtimes: { node: MINIMUM_NODE } },
  };
}

/** A simple icon: a bissap-colored disc, with a white “A”. 512 × 512, transparent background. */
export async function icon(path: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <circle cx="256" cy="256" r="240" fill="rgb(150,20,60)"/>
  <text x="256" y="268" font-family="Arial, Helvetica, sans-serif" font-size="300" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">A</text>
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path);
}

export async function prepare(): Promise<string> {
  if (existsSync(FOLDER)) rmSync(FOLDER, { recursive: true, force: true });
  mkdirSync(join(FOLDER, "server"), { recursive: true });
  // A single file, MCP SDK and Zod included. The require of the CommonJS libraries goes through createRequire.
  await build({
    entryPoints: [join(ROOT, "ch15", "comptoir_for_awa.ts")],
    outfile: join(FOLDER, "server", "index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: "warning",
  });
  copyFileSync(join(PYTHON, "comptoir", "data", "delices_awa.json"), join(FOLDER, "server", "catalog.json"));
  const [tools, prompts] = await inventory();
  writeFileSync(join(FOLDER, "manifest.json"), pythonJson(manifest(tools, prompts), 2) + "\n", "utf8");
  await icon(join(FOLDER, "icon.png"));
  return FOLDER;
}

export function packageExtension(): string {
  if (!existsSync(MCPB)) throw new Error(`The mcpb CLI cannot be found: ${MCPB}. Install it: npm ci in python/ch15/tools.`);
  const run = (args: string[]): void => {
    const output = spawnSync(process.execPath, [MCPB, ...args], { stdio: "inherit" });
    if (output.status !== 0) throw new Error(`mcpb ${args[0]} failed (code ${output.status}).`);
  };
  run(["validate", join(FOLDER, "manifest.json")]);
  const bundle = join(BUILD, `${NAME}-${VERSION}.mcpb`);
  run(["pack", FOLDER, bundle]);
  return bundle;
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: { package: { type: "boolean", default: false } } }); // validate and package with mcpb
  const folder = await prepare();
  console.log(`Extension prepared: ${relative(ROOT, folder)}`);
  if (args.package) console.log(`Package: ${relative(ROOT, packageExtension())}`);
}

if (isMain(import.meta.url)) await main();
