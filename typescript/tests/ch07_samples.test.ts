// The sample documents of chapter 7: present, well formed, consistent with the checks
// (python/tests/test_ch07_samples.py). They are those of the Python version, made once by
// python/ch07/make_samples.py and read in place.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { DOCUMENTS } from "../ch07/measure_accuracy.ts";
import { expectedTokens } from "../comptoir/documents.ts";
import { PurchaseOrder, checkOrder } from "../comptoir/extraction.ts";

type ExpectedLine = { product: string; quantity: number | null; unit_price_read: number };
const expected = JSON.parse(readFileSync(join(DOCUMENTS, "expected.json"), "utf8")) as Record<
  string,
  { customer: string; neighborhood: string; total_read: number | null; lines: ExpectedLine[] }
>;

test("the documents and the expected values are in the repository", () => {
  assert.deepEqual(Object.keys(expected), ["order-01.jpg", "order-02.jpg", "order-03.jpg", "order-04.jpg", "invoice-01.pdf"]);
  for (const name of Object.keys(expected)) assert.ok(existsSync(join(DOCUMENTS, name)), name);
  assert.ok(existsSync(join(DOCUMENTS, "supplier-terms.pdf")));
});

test("a sample photo costs a few thousand tokens", async () => {
  const { width, height } = await sharp(join(DOCUMENTS, "order-01.jpg")).metadata();
  const tokens = expectedTokens(width!, height!, "claude-sonnet-5-5");
  assert.ok(tokens > 2000 && tokens <= 4784, String(tokens));
});

test("the text PDF is well formed", () => {
  const content = readFileSync(join(DOCUMENTS, "supplier-terms.pdf"));
  const text = content.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4") && text.trimEnd().endsWith("%%EOF"));
  // Each entry of the xref table points to the start of its object.
  const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
  const entries = [...text.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
  entries.forEach((position, i) => assert.ok(text.slice(position).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
  assert.ok(text.includes("/Count 2")); // two pages, for citations per page
});

/** The order as a right reading would return it, from the expected values. */
function expectedOrder(name: string): PurchaseOrder {
  const e = expected[name]!;
  return PurchaseOrder.parse({
    document_type: "purchase_order",
    customer: e.customer,
    neighborhood: e.neighborhood,
    delivery_date_read: null,
    lines: e.lines.map((l) => ({
      read_label: l.product, product: l.product, quantity: l.quantity, unit_price_read: l.unit_price_read,
      legibility: l.quantity === null ? "illegible" : "legible", remark: null,
    })),
    total_read: e.total_read,
    remarks: [],
  });
}

test("each sample order raises the intended problem", () => {
  assert.deepEqual(checkOrder(expectedOrder("order-01.jpg")).anomalies, []);
  assert.equal(checkOrder(expectedOrder("order-02.jpg")).anomalies.length, 2); // price and total
  assert.equal(checkOrder(expectedOrder("order-03.jpg")).computedAmount, null); // stained quantity
  assert.equal(checkOrder(expectedOrder("order-04.jpg")).computedAmount, 5000);
});
