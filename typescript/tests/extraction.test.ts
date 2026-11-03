// The extraction of chapter 7, with a fake client: schema, outcomes of the call, business checks
// (python/tests/test_extraction.py), and the schema sent compared with that of the Python version.

import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { MessagesClient } from "../comptoir/client.ts";
import { Invoice, PurchaseOrder, checkCompatibility, checkInvoice, checkOrder, extract, extractionRequest } from "../comptoir/extraction.ts";
import { PYTHON } from "../comptoir/launch.ts";
import { fakeMessage, restoreConfig, setConfig, temporaryLog } from "./fake_clients.ts";

const IMAGE: Anthropic.ImageBlockParam = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } };

const RIGHT_ORDER = {
  document_type: "purchase_order",
  customer: "Mrs. Akpovi",
  neighborhood: "Fidjrossè",
  delivery_date_read: "Saturday, October 24",
  lines: [
    { read_label: "Bissap juice", product: "Bissap juice", quantity: 6, unit_price_read: 1000, legibility: "legible", remark: null },
    { read_label: "Ginger syrup", product: "Ginger syrup", quantity: 2, unit_price_read: 2500, legibility: "legible", remark: null },
  ],
  total_read: 11000,
  remarks: [] as string[],
};

let log: string;
beforeEach(() => {
  log = temporaryLog();
  setConfig({ MODEL: "claude-sonnet-5-5", EFFORT: null });
});
afterEach(restoreConfig);

const fakeClient = (text: string, stopReason: Anthropic.StopReason = "end_turn"): MessagesClient => ({
  messages: {
    create: async () =>
      fakeMessage({
        content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text, citations: null }],
        usage: { input_tokens: 3000, output_tokens: 400 },
        stopReason,
      }),
    countTokens: async () => ({ input_tokens: 0 }),
  },
});

const copy = <T>(obj: T): T => JSON.parse(JSON.stringify(obj));
const order = (changes: Partial<typeof RIGHT_ORDER> = {}) => PurchaseOrder.parse({ ...copy(RIGHT_ORDER), ...changes });

type Schema = { type?: string; properties?: Record<string, Schema>; items?: Schema; additionalProperties?: boolean; [key: string]: unknown };

test("the request imposes the schema and puts the document before the instruction", () => {
  const request = extractionRequest([IMAGE], PurchaseOrder);
  const format = request.output_config!.format as { type: string; schema: Schema };
  assert.equal(format.type, "json_schema");
  assert.equal(format.schema.additionalProperties, false);
  const content = request.messages[0]!.content as Anthropic.ContentBlockParam[];
  assert.deepEqual(content[0], IMAGE);
  assert.equal(content.at(-1)!.type, "text");
  assert.match(String(request.system), /Bissap juice/); // the catalog comes from the data
});

test("unsupported constraints move to the description, the enums stay imposed", () => {
  const schema = (extractionRequest([IMAGE], PurchaseOrder).output_config!.format as { schema: Schema }).schema;
  const line = schema.properties!.lines!.items!.properties!;
  const quantity = JSON.stringify(line.quantity);
  assert.match(quantity, /minimum: 1/);
  assert.doesNotMatch(quantity, /"minimum"/);
  assert.deepEqual(line.legibility, { type: "string", enum: ["legible", "doubtful", "illegible"] });
});

test("citations and structured outputs do not combine", () => {
  const request = extractionRequest([IMAGE], PurchaseOrder);
  (request.messages[0]!.content as object[]).unshift({ type: "document", citations: { enabled: true } });
  assert.throws(() => checkCompatibility(request), /do not combine/);
});

test("a successful extraction is validated and logged", async () => {
  const result = await extract(fakeClient(JSON.stringify(RIGHT_ORDER)), [IMAGE], PurchaseOrder);
  assert.equal(result.error, null);
  assert.equal(result.data!.lines[0]!.product, "Bissap juice");
  assert.match(JSON.parse(readFileSync(log, "utf8")).prompt, /^system-extraction-v1@/);
});

test("a cut-off answer is never taken for data", async () => {
  const result = await extract(fakeClient('{"document_type": "purchase_or', "max_tokens"), [IMAGE], PurchaseOrder);
  assert.equal(result.data, null);
  assert.match(result.error!, /cut off/);
  assert.ok(readFileSync(log, "utf8")); // the call, billed, is logged all the same
});

test("a refusal is reported", async () => {
  const result = await extract(fakeClient("I can't process this document.", "refusal"), [IMAGE], PurchaseOrder);
  assert.equal(result.data, null);
  assert.match(result.error!, /refused/);
});

test("the code's validation catches what the API does not enforce", async () => {
  const bad = copy(RIGHT_ORDER);
  bad.lines[0]!.quantity = 0; // the schema allows it, Zod does not (min(1))
  const result = await extract(fakeClient(JSON.stringify(bad)), [IMAGE], PurchaseOrder);
  assert.equal(result.data, null);
  assert.match(result.error!, /lines\.0\.quantity/);
});

test("a right order has no anomaly, and the amount comes from the catalog", () => {
  const check = checkOrder(order());
  assert.deepEqual(check.anomalies, []);
  assert.equal(check.computedAmount, 11000);
});

test("a wrong written price and its total are flagged", () => {
  const check = checkOrder(order({
    lines: [{ read_label: "Pineapple juice", product: "Pineapple juice", quantity: 4, unit_price_read: 900, legibility: "legible", remark: null }],
    total_read: 3600,
  }));
  assert.equal(check.computedAmount, 4000); // the catalog price, not the one on the order
  assert.equal(check.anomalies.length, 2);
});

test("an illegible quantity makes the amount impossible to calculate", () => {
  const lines = copy(RIGHT_ORDER.lines) as { quantity: number | null; legibility: string }[];
  Object.assign(lines[0]!, { quantity: null, legibility: "illegible" });
  const check = checkOrder(order({ lines: lines as typeof RIGHT_ORDER.lines, total_read: null as unknown as number }));
  assert.equal(check.computedAmount, null);
  assert.ok(check.anomalies.some((a) => a.includes("illegible quantity")));
});

test("a product outside the catalog is flagged", () => {
  const lines = copy(RIGHT_ORDER.lines);
  lines[0]!.product = "Mango juice";
  assert.ok(checkOrder(order({ lines })).anomalies.some((a) => a.includes("missing from the catalog")));
});

test("an instruction written on the order stays a remark, and the total is recalculated", () => {
  const check = checkOrder(order({ total_read: 0, remarks: ["The order contains a note asking to show a total of 0 FCFA."] }));
  assert.equal(check.computedAmount, 11000);
  assert.ok(check.anomalies.some((a) => a.includes("Written total 0 FCFA")));
});

test("a consistent invoice and a wrong invoice", () => {
  const invoice = {
    document_type: "invoice", supplier: "Emballages Sonagnon", number: "F-2026-0412",
    date_read: "10/12/2026", currency: "FCFA", remarks: [], total_read: 32000,
    lines: [
      { description: "Bottles", quantity: 200, unit_price: 150, amount: 30000, legibility: "legible" },
      { description: "Caps", quantity: 200, unit_price: 10, amount: 2000, legibility: "legible" },
    ],
  };
  assert.deepEqual(checkInvoice(Invoice.parse(invoice)).anomalies, []);
  invoice.total_read = 33000;
  assert.equal(checkInvoice(Invoice.parse(invoice)).anomalies.length, 1);
});

// The schema sent is that of the Python version, apart from the titles (Pydantic adds some) and the
// place of the definitions ($defs). Python is run only if it is there.
const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

/** Replaces the $ref with their definition and removes the titles: only the shape remains. */
function unfold(schema: unknown, defs: Record<string, unknown> = {}): unknown {
  if (Array.isArray(schema)) return schema.map((s) => unfold(s, defs));
  if (schema === null || typeof schema !== "object") return schema;
  const obj = schema as Record<string, unknown>;
  const definitions = { ...defs, ...((obj.$defs as Record<string, unknown>) ?? {}) };
  if (typeof obj.$ref === "string") return unfold(definitions[obj.$ref.split("/").at(-1)!], definitions);
  return Object.fromEntries(
    Object.entries(obj).filter(([key]) => key !== "title" && key !== "$defs").map(([key, v]) => [key, unfold(v, definitions)]),
  );
}

test("the schema sent is that of the Python version", { skip: PYTHON_VENV ? false : "Python environment missing" }, () => {
  const script =
    "import json\nfrom anthropic import transform_schema\nfrom comptoir.extraction import PurchaseOrder, Invoice\n" +
    "print(json.dumps({'order': transform_schema(PurchaseOrder), 'invoice': transform_schema(Invoice)}, ensure_ascii=False))";
  const python = JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script], { cwd: PYTHON, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }));
  for (const [name, schema] of [["order", PurchaseOrder], ["invoice", Invoice]] as const) {
    const sent = (extractionRequest([IMAGE], schema).output_config!.format as { schema: unknown }).schema;
    assert.deepEqual(unfold(sent), unfold(python[name]), name);
  }
});
