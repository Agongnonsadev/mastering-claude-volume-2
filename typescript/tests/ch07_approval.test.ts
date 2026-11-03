// The human approval of chapter 7: nothing is recorded without a “y” typed by Yao
// (python/tests/test_ch07_approval.py).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { approve } from "../ch07/approve_orders.ts";
import { DOCUMENTS } from "../ch07/measure_accuracy.ts";
import type { MessagesClient } from "../comptoir/client.ts";
import { fakeMessage, restoreConfig, setConfig, temporaryLog } from "./fake_clients.ts";

const ORDER = {
  document_type: "purchase_order", customer: "Mrs. Akpovi", neighborhood: "Fidjrossè",
  delivery_date_read: "Saturday, October 24", total_read: 6000, remarks: [],
  lines: [{ read_label: "Bissap", product: "Bissap juice", quantity: 6 as number | null, unit_price_read: 1000,
    legibility: "legible", remark: null }],
};

const fakeClient = (order: object): MessagesClient => ({
  messages: {
    create: async () => fakeMessage({ content: [{ type: "text", text: JSON.stringify(order), citations: null }], usage: { input_tokens: 3000, output_tokens: 300 } }),
    countTokens: async () => ({ input_tokens: 0 }),
  },
});

let register: string;
beforeEach(() => {
  temporaryLog();
  setConfig({ MODEL: "claude-sonnet-5-5" });
  register = join(mkdtempSync(join(tmpdir(), "comptoir-")), "orders.jsonl");
});
afterEach(restoreConfig);

test("without agreement, nothing is recorded", async () => {
  const order = await approve(fakeClient(ORDER), join(DOCUMENTS, "order-01.jpg"), () => "", register);
  assert.equal(order, null);
  assert.equal(existsSync(register), false);
});

test("with agreement, the order and its calculated amount are recorded", async () => {
  const order = await approve(fakeClient(ORDER), join(DOCUMENTS, "order-01.jpg"), () => "y", register);
  assert.equal(order?.amount_fcfa, 6000);
  assert.equal(order?.approved_by_a_human, true);
  assert.equal(JSON.parse(readFileSync(register, "utf8")).document, "order-01.jpg");
});

test("an amount impossible to calculate is not even proposed", async () => {
  const illegible = JSON.parse(JSON.stringify(ORDER));
  Object.assign(illegible.lines[0], { quantity: null, legibility: "illegible" });
  const questionsAsked: string[] = [];
  const order = await approve(fakeClient(illegible), join(DOCUMENTS, "order-03.jpg"), (q) => (questionsAsked.push(q), "y"), register);
  assert.equal(order, null);
  assert.deepEqual(questionsAsked, []);
  assert.equal(existsSync(register), false);
});
