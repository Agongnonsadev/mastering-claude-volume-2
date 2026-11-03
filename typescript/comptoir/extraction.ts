// Turn a photo of a purchase order or an invoice into validated data (chapter 7).
//
// Three layers, none of which trusts the previous one:
// 1. the schema, imposed on Claude by structured outputs: the form is guaranteed;
// 2. Zod validation, by the code: the constraints the API does not check;
// 3. business checks, by the code: catalog prices, totals, doubtful lines.
// Then a human approves, before anything is recorded.

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { type MessagesClient, textOf } from "./client.ts";
import { config } from "./config.ts";
import { type Cost, cost } from "./costs.ts";
import { PYTHON } from "./launch.ts";
import { logCall } from "./log.ts";
import { jsonFormat } from "./outputs.ts";
import { type Data, SystemPrompt, fill, loadData, renderCatalog } from "./prompt.ts";

export const MAX_TOKENS = 4000; // thinking included: a twenty-line order must fit without being cut off

const Legibility = z.enum(["legible", "doubtful", "illegible"]);

// --- The schemas --------------------------------------------------------------------------
// The descriptions are part of the prompt: Claude reads them. Constraints such as min(1), which the API
// does not enforce, go into the description (comptoir/outputs.ts); Zod checks them.

export const OrderLine = z.object({
  read_label: z.string().describe("The product as written on the order, copied without correction."),
  product: z.string().nullable().describe("The exact catalog name, only if the match is certain; otherwise null."),
  quantity: z.number().int().min(1).nullable().describe("The number of bottles; null if illegible or missing."),
  unit_price_read: z.number().int().nullable().describe("The unit price written on the order, in FCFA; null if it is not written or illegible."),
  legibility: Legibility,
  remark: z.string().nullable().describe("What is wrong with this line; null otherwise."),
});

export const PurchaseOrder = z.object({
  document_type: z.enum(["purchase_order", "other"]),
  customer: z.string().nullable().describe("The customer's name as it is written; null if there is none."),
  neighborhood: z.string().nullable().describe("The delivery neighborhood or address; null if there is none."),
  delivery_date_read: z.string().nullable().describe("The delivery date as it is written; null otherwise."),
  lines: z.array(OrderLine),
  total_read: z.number().int().nullable().describe("The total written on the order, in FCFA, copied without calculation; null otherwise."),
  remarks: z.array(z.string()).describe("The illegible, ambiguous or unusual passages of the document."),
});
export type PurchaseOrder = z.infer<typeof PurchaseOrder>;

export const InvoiceLine = z.object({
  description: z.string().describe("The description as it is written."),
  quantity: z.number().int().min(1).nullable().describe("The quantity invoiced; null if illegible."),
  unit_price: z.number().int().nullable().describe("The written unit price, in the invoice's currency; null otherwise."),
  amount: z.number().int().nullable().describe("The amount of the line as it is written; null otherwise."),
  legibility: Legibility,
});

export const Invoice = z.object({
  document_type: z.enum(["invoice", "other"]),
  supplier: z.string().nullable().describe("The supplier's name; null if it is illegible."),
  number: z.string().nullable().describe("The invoice number; null if there is none."),
  date_read: z.string().nullable().describe("The invoice date as it is written; null otherwise."),
  lines: z.array(InvoiceLine),
  total_read: z.number().int().nullable().describe("The total to pay written on the invoice, without calculation; null otherwise."),
  currency: z.string().nullable().describe("The currency written on the invoice (for example FCFA); null otherwise."),
  remarks: z.array(z.string()).describe("The illegible, ambiguous or unusual passages of the document."),
});
export type Invoice = z.infer<typeof Invoice>;

export type DocumentSchema = typeof PurchaseOrder | typeof Invoice;

const INSTRUCTIONS = new Map<DocumentSchema, string>([
  [PurchaseOrder, "Here is the photo of a purchase order received on WhatsApp. Extract its data."],
  [Invoice, "Here is a supplier invoice. Extract its data."],
]);

// --- The request --------------------------------------------------------------------------

type Request = Anthropic.MessageCreateParamsNonStreaming;
type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

export function extractionPrompt(version = "v1", data?: Data): SystemPrompt {
  const template = readFileSync(join(PYTHON, "comptoir", "prompts", `extraction_${version}.md`), "utf8").replace(/\r\n/g, "\n");
  const text = fill(template, { catalog: renderCatalog(data ?? loadData()) });
  return new SystemPrompt(text.trim(), `extraction-${version}`);
}

/** Citations and structured outputs do not combine: the API would answer with a 400 error. */
export function checkCompatibility(request: Request): void {
  const imposedFormat = Boolean(request.output_config?.format);
  const citations = request.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => (b as { citations?: { enabled?: boolean } }).citations?.enabled),
  );
  if (imposedFormat && citations) throw new Error("Citations and structured outputs do not combine: choose one or the other.");
}

export function extractionRequest(blocks: Anthropic.ContentBlockParam[], schema: DocumentSchema, prompt = extractionPrompt()): Request {
  const outputConfig: Anthropic.OutputConfig = { format: jsonFormat(schema) as Anthropic.JSONOutputFormat };
  if (config.EFFORT) outputConfig.effort = config.EFFORT as Effort;
  const request: Request = {
    model: config.MODEL,
    max_tokens: MAX_TOKENS,
    system: prompt.text,
    // The document first, the instruction next: that is the recommended order.
    messages: [{ role: "user", content: [...blocks, { type: "text", text: INSTRUCTIONS.get(schema)! }] }],
    output_config: outputConfig,
  };
  checkCompatibility(request);
  return request;
}

// --- The call and its outcomes ---------------------------------------------------------------

export interface Extraction<T> {
  data: T | null;
  error: string | null;
  stopReason: string | null;
  cost: Cost;
  requestId: string | null;
}

/**
 * Calls Claude and returns validated data, or an explicit error. Never doubtful data without saying so.
 *
 * client.messages.parse() is not used: in case of a refusal or a cut-off answer, it raises an exception
 * before returning the message, and the call, billed all the same, escapes the log.
 */
export async function extract<S extends DocumentSchema>(
  client: MessagesClient,
  blocks: Anthropic.ContentBlockParam[],
  schema: S,
  prompt = extractionPrompt(),
): Promise<Extraction<z.infer<S>>> {
  const request = extractionRequest(blocks, schema, prompt);
  const message = await client.messages.create(request);
  const price = cost(request.model, message.usage);
  const requestId = message._request_id ?? null;
  logCall(requestId, request.model, price, { prompt: prompt.id });

  const failure = (reason: string): Extraction<z.infer<S>> => ({ data: null, error: reason, stopReason: message.stop_reason, cost: price, requestId });

  // The schema is guaranteed only if the answer went through to the end normally.
  if (message.stop_reason === "refusal") return failure("Claude refused to process this document.");
  if (message.stop_reason === "max_tokens") return failure("Answer cut off before the end: raise max_tokens or split the document.");
  let json: unknown;
  try {
    json = JSON.parse(textOf(message));
  } catch {
    return failure("Answer rejected by the code's validation (unreadable JSON).");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    return failure(`Answer rejected by the code's validation (${fields}).`);
  }
  return { data: parsed.data as z.infer<S>, error: null, stopReason: message.stop_reason, cost: price, requestId };
}

// --- The business checks ----------------------------------------------------------------

export class Check {
  readonly anomalies: string[] = [];
  computedAmount: number | null = null; // calculated by the code, never by the model

  get toReview(): boolean {
    return this.anomalies.length > 0;
  }
}

export function checkOrder(order: PurchaseOrder, data?: Data): Check {
  const prices = new Map((data ?? loadData()).products.map((p) => [p.name, p.price_fcfa]));
  const check = new Check();
  if (order.document_type !== "purchase_order") {
    check.anomalies.push("This document is not a purchase order.");
    return check;
  }
  if (!order.lines.length) check.anomalies.push("No order line read.");

  let complete = order.lines.length > 0;
  let total = 0;
  order.lines.forEach((line, i) => {
    const name = `Line ${i + 1} (“${line.read_label}”)`;
    if (line.legibility !== "legible") check.anomalies.push(`${name}: ${line.legibility} reading.`);
    const catalogPrice = line.product === null ? undefined : prices.get(line.product);
    if (catalogPrice === undefined) {
      check.anomalies.push(`${name}: product missing from the catalog or uncertain.`);
      complete = false;
      return;
    }
    if (line.quantity === null) {
      check.anomalies.push(`${name}: illegible quantity.`);
      complete = false;
      return;
    }
    if (line.unit_price_read !== null && line.unit_price_read !== catalogPrice) {
      check.anomalies.push(`${name}: written price ${line.unit_price_read} FCFA, catalog ${catalogPrice} FCFA.`);
    }
    total += line.quantity * catalogPrice;
  });

  if (complete) {
    check.computedAmount = total;
    if (order.total_read !== null && order.total_read !== total) check.anomalies.push(`Written total ${order.total_read} FCFA, calculated total ${total} FCFA.`);
  }
  check.anomalies.push(...order.remarks.map((r) => `Reading remark: ${r}`));
  return check;
}

export function checkInvoice(invoice: Invoice): Check {
  const check = new Check();
  if (invoice.document_type !== "invoice") {
    check.anomalies.push("This document is not an invoice.");
    return check;
  }
  if (invoice.currency && !["FCFA", "XOF", "F CFA"].includes(invoice.currency.toUpperCase())) {
    check.anomalies.push(`Unusual currency: ${invoice.currency}.`);
  }

  let complete = invoice.lines.length > 0;
  let total = 0;
  invoice.lines.forEach((line, i) => {
    const name = `Line ${i + 1} (“${line.description}”)`;
    if (line.legibility !== "legible") check.anomalies.push(`${name}: ${line.legibility} reading.`);
    if (line.quantity === null || line.unit_price === null) {
      check.anomalies.push(`${name}: illegible quantity or price.`);
      complete = false;
      return;
    }
    const expected = line.quantity * line.unit_price;
    if (line.amount !== null && line.amount !== expected) check.anomalies.push(`${name}: written amount ${line.amount}, calculated ${expected}.`);
    total += expected;
  });

  if (complete) {
    check.computedAmount = total;
    if (invoice.total_read !== null && invoice.total_read !== total) check.anomalies.push(`Written total ${invoice.total_read}, calculated total ${total}.`);
  }
  check.anomalies.push(...invoice.remarks.map((r) => `Reading remark: ${r}`));
  return check;
}

/** The Comptoir sorts its samples by name: order-*.jpg, invoice-*.pdf. */
export function schemaFor(path: string): DocumentSchema {
  return basename(path).startsWith("invoice") ? Invoice : PurchaseOrder;
}
