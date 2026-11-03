// The shop: prices and fees calculated by the code, stock checked, an order created only once
// (python/tests/test_shop.py), and what it keeps or erases (python/tests/test_ch18.py).

import assert from "node:assert/strict";
import { test } from "node:test";
import { Shop, ShopRefusal, initial } from "../comptoir/shop.ts";

const MORNING = new Date("2026-10-20T08:00:00Z"); // 9 a.m. in Cotonou
const HOUR = 3600 * 1000;

/** Confirmation codes drawn in order, for reproducible tests. */
const sequence = (start = 4242) => {
  let n = start;
  return (max: number) => (n = (n * 7 + 13) % max);
};

const shop = (clock: () => Date = () => MORNING) => new Shop(":memory:", { clock, rng: sequence() });
const BISSAP_6 = [{ product: "Bissap juice", quantity: 6 }];

test("the initial stock, and an unknown product", () => {
  const s = shop();
  assert.equal(s.available("Bissap juice"), 40);
  assert.equal(s.available("Soursop juice"), 0);
  assert.equal(s.available("Mango juice"), null);
});

test("the total comes from the catalog, and delivery is free from 5 bottles", () => {
  const summary = shop().prepare("c1", BISSAP_6, "Mrs. Hounkpè", "Akpakpa");
  assert.equal(summary.total_fcfa, 6000);
  assert.equal(summary.delivery_fee, 0);
  assert.equal(summary.planned_delivery, "today"); // order placed before noon, Cotonou time
});

test("below 5 bottles, delivery costs 500 FCFA, and syrups do not count", () => {
  const summary = shop().prepare("c1", [{ product: "Bissap juice", quantity: 2 }, { product: "Ginger syrup", quantity: 3 }], "Mr. Dossou", "Zogbo");
  assert.equal(summary.delivery_fee, 500);
  assert.equal(summary.total_fcfa, 2000 + 7500 + 500);
});

test("in the afternoon, delivery is for tomorrow", () => {
  const afternoon = shop(() => new Date("2026-10-20T12:00:00Z")); // 1 p.m. in Cotonou
  assert.equal(afternoon.prepare("c1", [{ product: "Pineapple juice", quantity: 5 }], "A", "B").planned_delivery, "tomorrow");
});

const REFUSALS: [{ product: string; quantity: number }[], RegExp][] = [
  [[{ product: "Mango juice", quantity: 3 }], /missing from the catalog/],
  [[{ product: "Pineapple juice", quantity: 0 }], /at least 1/],
  [[{ product: "Pineapple juice", quantity: 15 }], /Insufficient stock: 12/],
  [[{ product: "Bissap juice", quantity: 40 }, { product: "Ginger juice", quantity: 20 }], /quote/],
  [[], /empty/],
];
for (const [lines, reason] of REFUSALS) {
  test(`the refusals say what to do: ${reason.source}`, () => {
    assert.throws(() => shop().prepare("c1", lines, "A", "B"), (e: unknown) => e instanceof ShopRefusal && reason.test(e.message));
  });
}

test("an order is created only once, and the stock goes down", () => {
  const s = shop();
  const code = s.prepare("c1", BISSAP_6, "A", "B").confirmation_code;
  const first = s.confirm("c1", code);
  const second = s.confirm("c1", code); // the customer sends their “YES” again: nothing more
  assert.equal(first.order, "C-0001");
  assert.equal(second.order, "C-0001");
  assert.ok(second.already_recorded);
  assert.equal(s.orders().length, 1);
  assert.equal(s.available("Bissap juice"), 34);
});

test("the old code is void after a change of mind", () => {
  let instant = MORNING;
  const s = shop(() => instant);
  const old = s.prepare("c1", [{ product: "Bissap juice", quantity: 4 }], "A", "B").confirmation_code;
  instant = new Date(MORNING.getTime() + 60_000);
  const recent = s.prepare("c1", BISSAP_6, "A", "B").confirmation_code;
  assert.throws(() => s.confirm("c1", old), /replaced/);
  assert.equal(s.confirm("c1", recent).total_fcfa, 6000);
});

test("a code works only in its conversation", () => {
  const s = shop();
  const code = s.prepare("c1", BISSAP_6, "A", "B").confirmation_code;
  assert.throws(() => s.confirm("other-conversation", code), /no summary/);
});

test("a summary expires", () => {
  let instant = MORNING;
  const s = shop(() => instant);
  const code = s.prepare("c1", BISSAP_6, "A", "B").confirmation_code;
  instant = new Date(MORNING.getTime() + 3 * HOUR);
  assert.throws(() => s.confirm("c1", code), /expired/);
});

test("the stock is checked again at the moment of creating", () => {
  const s = shop();
  const codeC1 = s.prepare("c1", [{ product: "Pineapple juice", quantity: 10 }], "A", "B").confirmation_code;
  s.confirm("c2", s.prepare("c2", [{ product: "Pineapple juice", quantity: 5 }], "C", "D").confirmation_code);
  assert.throws(() => s.confirm("c1", codeC1), /stock/); // only 7 pineapples are left
});

// --- Keep for the promised time, erase on request (chapter 18) -----------------------------

function shopWithHistory() {
  let instant = new Date("2026-06-01T09:00:00Z"); // 10 a.m. in Cotonou
  const s = new Shop(":memory:", { clock: () => instant, rng: sequence() });
  const summary = s.prepare("old", BISSAP_6, "Larissa Noudéhou", "Fidjrossè");
  s.confirm("old", summary.confirmation_code);
  s.prepare("abandoned", [{ product: "Pineapple juice", quantity: 2 }], "Koffi Agbo", "Akpakpa");
  s.passOn("old", "discount", "Larissa Noudéhou asks for a discount.");
  instant = new Date("2026-10-20T09:00:00Z");
  const recent = s.prepare("recent", BISSAP_6, "Mariam Sossou", "Gbégamey");
  s.confirm("recent", recent.confirmation_code);
  return s;
}

test("the purge applies Awa's periods", () => {
  const s = shopWithHistory();
  assert.deepEqual(s.purge(90, 90, 2), { requests_erased: 1, summaries_erased: 1, names_reduced: 1 });
  const names = Object.fromEntries(s.db.prepare("SELECT conversation, customer_name FROM summaries").all().map((l) => [l.conversation, l.customer_name]));
  assert.deepEqual(names, { old: "Larissa N.", recent: "Mariam Sossou" });
  assert.equal(s.orders().length, 2); // the orders stay, for the accounts
  assert.deepEqual(s.purge(90, 90, 2), { requests_erased: 0, summaries_erased: 0, names_reduced: 0 });
});

test("erase at a customer's request, except what the accounts require", () => {
  const s = shopWithHistory();
  assert.deepEqual(s.erase("old"), { requests_erased: 1, summaries_erased: 0 });
  const name = s.db.prepare("SELECT customer_name FROM summaries WHERE conversation = 'old'").get()!.customer_name;
  assert.equal(name, "Larissa N.");
  assert.equal(initial("Koffi"), "Koffi");
  assert.equal(initial("Larissa N."), "Larissa N.");
});
