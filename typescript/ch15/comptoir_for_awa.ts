// Comptoir for Awa: the MCP server of Délices d'Awa (chapter 15).
//
// Awa plugs it into her Claude app, as a desktop extension; Yao, into Claude Code. What Claude can do with
// it:
// - read: the orders of a day, the stock, the sales of a week, one order, the catalog;
// - prepare: an evening review, an inventory (two prompts that Awa chooses);
// - write, a single thing: correct the stock after an inventory, in two steps. prepare_correction shows the
//   difference and returns a token; apply_correction accepts only that token, only once, within ten
//   minutes, and only if the stock has not moved in the meantime. In between, Awa says yes.
//
// The module depends only on Node, the MCP SDK and Zod: ch15/build_extension.ts makes it a single file, which
// the app launches with its own Node. Configuration, through the environment:
//   COMPTOIR_SHOP       path of the shop's SQLite database (required)
//   COMPTOIR_CATALOG    path of the JSON catalog (default: catalog.json next to this file, otherwise
//                       python/comptoir/data/delices_awa.json in the repository)
//   COMPTOIR_TODAY      today's date, YYYY-MM-DD, for demonstrations (optional)
//
// Run: npx tsx ch15/comptoir_for_awa.ts  (stdio). Nothing is written on standard output, which belongs to
// the protocol: the log goes to standard error. The texts and the schemas announced are those of the
// Python version (ch15/schemas.ts).

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { addDays, mondayOf, readDate, weekday } from "../comptoir/dates.ts";
import { isMain } from "../comptoir/launch.ts";
import { pythonJson, splitWords } from "../comptoir/python.ts";
import { round } from "../comptoir/rounding.ts";
import { INSTRUCTIONS, PROMPTS, RESOURCES, RESOURCE_TEMPLATES, TOOLS } from "./schemas.ts";

export const VERSION = "0.1.0";
const COTONOU_OFFSET = 3600_000; // Benin is at UTC+1, with no daylight saving time
export const CORRECTION_VALIDITY_MS = 10 * 60_000;
export const MAXIMUM_DIFFERENCE = 200; // beyond that, it is no longer an inventory correction: Awa does it herself
const LOW_THRESHOLDS: Record<string, number> = { juice: 10, syrup: 5 };
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** An error for Claude: its message tells it what to do (the Python version's ToolError). */
export class ToolFailure extends Error {}

/** The time it is, in UTC; the tests set it. */
export const clock = { now: (): Date => new Date() };

/** The log, on standard error, when the server runs for real (main). */
let log: ((message: string) => void) | null = null;

// ---------- Configuration and database ------------------------------------------------------

function databasePath(): string {
  const raw = (process.env.COMPTOIR_SHOP ?? "").trim();
  if (!raw || raw.includes("${")) {
    throw new ToolFailure("No shop database is set. In the settings of the Comptoir for Awa extension, choose the “Shop database” file.");
  }
  if (!existsSync(raw) || !statSync(raw).isFile()) {
    throw new ToolFailure(`The shop's database cannot be found: ${raw}. Check the extension's “Shop database” setting, or ask Yao for the right file.`);
  }
  return raw;
}

export function open(): DatabaseSync {
  const db = new DatabaseSync(databasePath());
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
}

/** The writes of a block, together or not at all (Python's with db:). */
function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface Product {
  name: string;
  format: string;
  price_fcfa: number;
}
export interface Catalog {
  products: Product[];
  terms: string[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

export function catalog(): Catalog {
  const candidates = [(process.env.COMPTOIR_CATALOG ?? "").trim(), join(HERE, "catalog.json"), join(HERE, "..", "..", "python", "comptoir", "data", "delices_awa.json")];
  for (const c of candidates) if (c && existsSync(c) && statSync(c).isFile()) return JSON.parse(readFileSync(c, "utf8")) as Catalog;
  throw new ToolFailure("The Délices d'Awa catalog cannot be found: reinstall the extension.");
}

/** A time, as Cotonou reads it: the day (YYYY-MM-DD) and the time (“09:15”). */
export interface LocalTime {
  day: string;
  time: string;
}

function local(instant: Date): LocalTime {
  const d = new Date(instant.getTime() + COTONOU_OFFSET);
  const two = (n: number): string => String(n).padStart(2, "0");
  return { day: d.toISOString().slice(0, 10), time: `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}` };
}

export function today(): string {
  const forced = (process.env.COMPTOIR_TODAY ?? "").trim();
  if (forced && !forced.includes("${")) {
    const day = readDate(forced);
    if (day === null) throw new Error(`Invalid isoformat string: '${forced}'`);
    return day;
  }
  return local(clock.now()).day;
}

// ---------- Formatting for Awa --------------------------------------------------------------

/** 12500 -> “12,500 FCFA”. */
export const fcfa = (amount: number): string => `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} FCFA`;

export function dayInFull(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return `${DAYS[weekday(day)]}, ${MONTHS[month - 1]} ${date}, ${year}`;
}

/** “Larissa Noudéhou” -> “Larissa N.”: enough to deliver, without the full name. */
export function discreetCustomer(name: string): string {
  const parts = splitWords(name);
  return parts.length === 1 ? parts[0]! : `${parts[0]} ${[...parts.at(-1)!][0]}.`;
}

// ---------- Reads ---------------------------------------------------------------------------

export interface OrderLine {
  product: string;
  quantity: number;
  unit_price: number;
}

export interface Order {
  number: string;
  when: LocalTime;
  customer: string;
  neighborhood: string;
  lines: OrderLine[];
  fee: number;
  total: number;
}

export function orders(db: DatabaseSync): Order[] {
  const rows = db
    .prepare(
      "SELECT o.id, o.created_at, o.total, s.customer_name, s.neighborhood, s.lines, s.delivery_fee " +
        "FROM orders o JOIN summaries s ON s.id = o.summary ORDER BY o.created_at",
    )
    .all() as { id: string; created_at: string; total: number; customer_name: string; neighborhood: string; lines: string; delivery_fee: number }[];
  // The database's dates, in Cotonou time, whatever the time zone they were written in.
  return rows.map((r) => ({
    number: r.id,
    when: local(new Date(r.created_at)),
    customer: discreetCustomer(r.customer_name),
    neighborhood: r.neighborhood,
    lines: JSON.parse(r.lines) as OrderLine[],
    fee: r.delivery_fee,
    total: r.total,
  }));
}

const products = (c: Catalog): Map<string, Product> => new Map(c.products.map((p) => [p.name, p]));
// The juices come in 500 ml bottles, the syrups in smaller bottles: their low stock is counted apart.
const kind = (p: Product): string => (p.format.endsWith("ml bottle") ? "juice" : "syrup");
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

export function readOrdersOfTheDay(db: DatabaseSync, day: string) {
  const ofTheDay = orders(db).filter((o) => o.when.day === day);
  const list = ofTheDay.map((o) => ({
    number: o.number,
    time: o.when.time,
    customer: o.customer,
    neighborhood: o.neighborhood,
    products: o.lines.map((l) => `${l.quantity} × ${l.product}`).join(", "),
    total_fcfa: o.total,
  }));
  const total = sum(ofTheDay.map((o) => o.total));
  const when = dayInFull(day);
  const summary = ofTheDay.length ? `${ofTheDay.length} order${ofTheDay.length > 1 ? "s" : ""} on ${when}, for ${fcfa(total)}.` : `No order on ${when}.`;
  return { day, count: ofTheDay.length, total_fcfa: total, orders: list, summary };
}

export function readStock(db: DatabaseSync, c: Catalog) {
  const quantities = new Map((db.prepare("SELECT product, quantity FROM stock").all() as { product: string; quantity: number }[]).map((l) => [l.product, l.quantity]));
  const lines = [...products(c)].map(([name, product]) => {
    const quantity = quantities.get(name) ?? 0;
    const state = quantity === 0 ? "out_of_stock" : quantity < LOW_THRESHOLDS[kind(product)]! ? "low" : "sufficient";
    return { product: name, format: product.format, quantity, state };
  });
  const outOfStock = lines.filter((l) => l.state === "out_of_stock").map((l) => l.product);
  const low = lines.filter((l) => l.state === "low").map((l) => `${l.product} (${l.quantity})`);
  const parts: string[] = [];
  if (outOfStock.length) parts.push("Out of stock: " + outOfStock.join(", ") + ".");
  if (low.length) parts.push("Low stock: " + low.join(", ") + ".");
  return { products: lines, summary: parts.join(" ") || "All the products are in stock." };
}

export function readSalesOfTheWeek(db: DatabaseSync, _c: Catalog, aDay: string) {
  const monday = mondayOf(aDay);
  const sunday = addDays(monday, 6);
  const all = orders(db);
  const week = all.filter((o) => monday <= o.when.day && o.when.day <= sunday);
  const previous = all.filter((o) => addDays(monday, -7) <= o.when.day && o.when.day < monday);
  const quantities = new Map<string, number>();
  const amounts = new Map<string, number>();
  for (const o of week) {
    for (const l of o.lines) {
      quantities.set(l.product, (quantities.get(l.product) ?? 0) + l.quantity);
      amounts.set(l.product, (amounts.get(l.product) ?? 0) + l.quantity * l.unit_price);
    }
  }
  // By decreasing quantity; at equal quantity, the order of appearance (the sort is stable, as in Python).
  const byProduct = [...quantities.keys()].sort((a, b) => quantities.get(b)! - quantities.get(a)!).map((p) => ({ product: p, quantity: quantities.get(p)!, amount_fcfa: amounts.get(p)! }));
  const total = sum(week.map((o) => o.total));
  const before = sum(previous.map((o) => o.total));
  let trend = "";
  if (before) {
    const change = round((100 * (total - before)) / before);
    trend = ` (${change >= 0 ? "+" : ""}${change}% compared with the previous week)`;
  }
  const best = byProduct.length ? ` Best seller: ${byProduct[0]!.product}, ${byProduct[0]!.quantity}.` : "";
  const summary = `From ${dayInFull(monday)} to ${dayInFull(sunday)}: ${week.length} orders, ${fcfa(total)}${trend}.${best}`;
  return { start: monday, end: sunday, orders: week.length, total_fcfa: total, by_product: byProduct, previous_week_fcfa: before, summary };
}

// ---------- The only write: correcting the stock --------------------------------------------

export const CORRECTIONS_TABLE = `CREATE TABLE IF NOT EXISTS stock_corrections (
    token TEXT PRIMARY KEY, product TEXT NOT NULL, before INTEGER NOT NULL, after INTEGER NOT NULL,
    prepared_at TEXT NOT NULL, status TEXT NOT NULL, applied_at TEXT)`;

/** datetime.isoformat() of a UTC instant: “2026-10-21T07:00:00+00:00”. */
function isoformat(instant: Date): string {
  const ms = instant.getUTCMilliseconds();
  return instant.toISOString().replace(/\.\d{3}Z$/, ms ? `.${String(ms).padStart(3, "0")}000+00:00` : "+00:00");
}

const stockOf = (db: DatabaseSync, product: string): number =>
  ((db.prepare("SELECT quantity FROM stock WHERE product = ?").get(product) as { quantity: number } | undefined) ?? { quantity: 0 }).quantity;

export function prepare(db: DatabaseSync, c: Catalog, product: string, countedQuantity: number, now: Date) {
  if (!products(c).has(product)) throw new ToolFailure(`“${product}” is not in the catalog. Products: ${[...products(c).keys()].join(", ")}.`);
  const current = stockOf(db, product);
  const difference = countedQuantity - current;
  if (Math.abs(difference) > MAXIMUM_DIFFERENCE) {
    throw new ToolFailure(`The difference would be ${difference} for ${product}: that is too much for an inventory correction. Check the count; for a restocking, Awa goes through the Comptoir's screen.`);
  }
  // The token is recorded in the database, not in memory: it survives a restart of the server, and a
  // stateless remote server (chapter 16) will find it the same way.
  const token = randomBytes(4).toString("hex");
  inTransaction(db, () => {
    db.exec(CORRECTIONS_TABLE);
    db.prepare("INSERT INTO stock_corrections VALUES (?, ?, ?, ?, ?, 'prepared', NULL)").run(token, product, current, countedQuantity, isoformat(now));
  });
  const end = local(new Date(now.getTime() + CORRECTION_VALIDITY_MS));
  let say: string;
  if (difference === 0) say = `The stock of ${product} is already ${current}: nothing to correct.`;
  else {
    const direction = difference > 0 ? "more" : "fewer";
    say = `The Comptoir counts ${current} for ${product}; you counted ${countedQuantity}, that is ${Math.abs(difference)} ${direction}. Do you want the stock to go to ${countedQuantity}?`;
  }
  return { product, current_stock: current, counted_quantity: countedQuantity, difference, token, valid_until: end.time, to_tell_awa: say };
}

export function apply(db: DatabaseSync, token: string, now: Date) {
  db.exec(CORRECTIONS_TABLE);
  const row = db.prepare("SELECT * FROM stock_corrections WHERE token = ?").get(token.trim()) as
    | { token: string; product: string; before: number; after: number; prepared_at: string; status: string }
    | undefined;
  if (!row || row.status !== "prepared") {
    throw new ToolFailure("This token is unknown or has already been used. Prepare a new correction with prepare_correction and show the difference to Awa.");
  }
  if (now.getTime() - new Date(row.prepared_at).getTime() > CORRECTION_VALIDITY_MS) {
    inTransaction(db, () => db.prepare("UPDATE stock_corrections SET status = 'expired' WHERE token = ?").run(row.token));
    throw new ToolFailure("This token has expired (10 minutes). Prepare the correction again and ask Awa for her consent again.");
  }
  // Like Python's with db:: an error in the block cancels everything it wrote, the “outdated” mark included.
  inTransaction(db, () => {
    const current = stockOf(db, row.product);
    if (current !== row.before) {
      db.prepare("UPDATE stock_corrections SET status = 'outdated' WHERE token = ?").run(row.token);
      throw new ToolFailure(`The stock of ${row.product} has changed since the preparation (${row.before} → ${current}, probably a sale). Prepare a new correction.`);
    }
    db.prepare("INSERT OR REPLACE INTO stock VALUES (?, ?)").run(row.product, row.after);
    db.prepare("UPDATE stock_corrections SET status = 'applied', applied_at = ? WHERE token = ?").run(isoformat(now), row.token);
  });
  log?.(`correction applied: ${row.product} ${row.before} -> ${row.after}`);
  return { product: row.product, before: row.before, after: row.after, summary: `Done: the stock of ${row.product} went from ${row.before} to ${row.after}.` };
}

// ---------- The MCP server ------------------------------------------------------------------

export type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/** A tool's result as the Python version returns it: the structured output, and the same as JSON. */
export async function execute(name: string, work: () => Record<string, unknown> | Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    const output = await work();
    return { content: [{ type: "text", text: pythonJson(output, 2) }], structuredContent: output };
  } catch (error) {
    return { content: [{ type: "text", text: `Error executing tool ${name}: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

/** Opens the database for the time of a call, and closes it whatever happens. */
export function withTheDatabase<T>(work: (db: DatabaseSync) => T): T {
  const db = open();
  try {
    return work(db);
  } finally {
    db.close();
  }
}

const givenDay = (day: string | null | undefined): string => (day ? readDate(day)! : today());
const resource = (name: string) => RESOURCES.find((r) => r.name === name) ?? RESOURCE_TEMPLATES.find((r) => r.name === name)!;
const prompt = (name: string) => PROMPTS.find((p) => p.name === name)!;

/** A fresh server, with its five tools, its two resources and its two prompts. */
export function createServer(): McpServer {
  const server = new McpServer({ name: "comptoir-for-awa", title: "Comptoir for Awa", version: VERSION }, { instructions: INSTRUCTIONS });
  register(server);
  return server;
}

/**
 * Declares on a server the Comptoir's tools, resources and prompts, except those of `except`: the online
 * server of chapter 16 takes everything again, to the character, and redefines apply_correction.
 */
export function register(server: McpServer, except: string[] = []): void {
  const declare = <A extends Record<string, unknown>>(name: keyof typeof TOOLS, work: (args: A) => Record<string, unknown>): void => {
    if (except.includes(name)) return;
    const t = TOOLS[name];
    server.registerTool(
      name,
      {
        title: t.title,
        description: t.description,
        inputSchema: z.fromJSONSchema(t.input as never) as z.ZodObject,
        outputSchema: z.fromJSONSchema(t.output as never) as z.ZodObject,
        annotations: t.annotations,
        ...("_meta" in t ? { _meta: t._meta } : {}),
      },
      (async (args: A) => execute(name, () => work(args))) as never,
    );
  };

  declare<{ day?: string | null }>("orders_of_the_day", ({ day }) => withTheDatabase((db) => readOrdersOfTheDay(db, givenDay(day))));
  declare("stock", () => withTheDatabase((db) => readStock(db, catalog())));
  declare<{ a_day_of_the_week?: string | null }>("sales_of_the_week", ({ a_day_of_the_week: day }) =>
    withTheDatabase((db) => readSalesOfTheWeek(db, catalog(), givenDay(day))),
  );
  // prepare_correction writes a draft correction (the token), never the stock: so it is not “read-only”,
  // but it destroys nothing.
  declare<{ product: string; counted_quantity: number }>("prepare_correction", ({ product, counted_quantity }) =>
    withTheDatabase((db) => prepare(db, catalog(), product, counted_quantity, clock.now())),
  );
  // Claude Code asks for the person's consent at each call, whatever the permission mode
  // (_meta “anthropic/requiresUserInteraction”, in ch15/schemas.ts).
  declare<{ token: string }>("apply_correction", ({ token }) => withTheDatabase((db) => apply(db, token, clock.now())));

  const r = resource("catalog");
  server.registerResource("catalog", "comptoir://catalog", { title: r.title, description: r.description, mimeType: r.mimeType }, async (uri) => {
    const c = catalog();
    const lines = ["# Délices d'Awa: catalog", "", ...c.products.map((p) => `- ${p.name} (${p.format}): ${fcfa(p.price_fcfa)}`), "", "## Terms", "", ...c.terms.map((term) => `- ${term}`)];
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: lines.join("\n") }] };
  });

  const t = resource("one_order");
  server.registerResource(
    "one_order",
    new ResourceTemplate("comptoir://order/{number}", { list: undefined }),
    { title: t.title, description: t.description, mimeType: t.mimeType },
    async (uri, { number }) =>
      withTheDatabase((db) => {
        const o = orders(db).find((x) => x.number === number);
        if (!o) throw new ToolFailure(`No order has the number ${number}.`);
        const lines = [
          `# Order ${o.number}`,
          "",
          `- Date: ${dayInFull(o.when.day)}, ${o.when.time}`,
          `- Customer: ${o.customer}, ${o.neighborhood}`,
          ...o.lines.map((l) => `- ${l.quantity} × ${l.product} at ${fcfa(l.unit_price)}`),
          `- Delivery: ${o.fee ? fcfa(o.fee) : "free"}`,
          `- Total: ${fcfa(o.total)}`,
        ];
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: lines.join("\n") }] };
      }),
  );

  const review = prompt("evening_review");
  server.registerPrompt("evening_review", { title: review.title, description: review.description, argsSchema: { day: z.string().optional() } }, ({ day }) => {
    const when = day ? `for ${day}` : "for today";
    const text =
      `Give me the evening review ${when}, in five lines at most: the number of orders and the total ` +
      "(orders_of_the_day tool), the products out of stock or low in stock (stock tool), and what I " +
      "must prepare or order for tomorrow. Give the figures as the tools return them. Do not " +
      "change anything.";
    return { description: review.description, messages: [{ role: "user", content: { type: "text", text } }] };
  });

  const inventory = prompt("inventory");
  server.registerPrompt("inventory", { title: inventory.title, description: inventory.description }, () => ({
    description: inventory.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "I am doing my inventory. For each product I give you with the counted quantity, prepare the " +
            "correction (prepare_correction), tell me the difference, and wait for me to answer yes before " +
            "applying it. One product at a time. At the end, summarize what changed.",
        },
      },
    ],
  }));
}

/** A log on standard error, in the Python version's format (logging: date, name, message). */
export function logOnStandardError(name: string): (message: string) => void {
  return (message) => {
    const t = new Date();
    const date = new Date(t.getTime() - t.getTimezoneOffset() * 60_000).toISOString().replace("T", " ").replace(/\.(\d{3})Z$/, ",$1");
    console.error(`${date} ${name} ${message}`);
  };
}

/** Plugs in the Comptoir's log (the corrections applied): the online server does it too. */
export function plugLog(l: ((message: string) => void) | null): void {
  log = l;
}

async function main(): Promise<void> {
  plugLog(logOnStandardError("comptoir_for_awa"));
  await createServer().connect(new StdioServerTransport());
}

// Launched directly (by tsx, or once packaged by the app), and not imported by a test.
if (isMain(import.meta.url)) await main();
