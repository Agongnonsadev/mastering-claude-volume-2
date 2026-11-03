// The budget: reserve the maximum, settle the real cost, never exceed a ceiling
// (python/tests/test_budget.py, and the quota per address of python/tests/test_ch18.py).

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { Budget } from "../comptoir/budget.ts";
import { maxCost } from "../comptoir/costs.ts";
import { approx, restoreConfig, setConfig } from "./fake_clients.ts";

beforeEach(() => {
  setConfig({ CUSTOMER_DAILY_QUOTA: 0.15, NETWORK_DAILY_QUOTA: 0.4, DAILY_BUDGET: 1.3, MONTHLY_BUDGET: 26.0, ALERT_THRESHOLD: 0.8 });
});
afterEach(restoreConfig);

test("the maximum cost of a call", () => {
  // 3,000 input tokens and 2,000 output tokens at most, at Sonnet 5.5's price ($2 and $10 per million).
  approx(maxCost("claude-sonnet-5-5", 3000, 2000), 0.026);
});

test("reserve then settle the real cost", () => {
  const budget = new Budget();
  const decision = budget.reserve("c1", 0.026);
  assert.ok(decision.accepted);
  approx(budget.forDay(), 0.026);
  budget.settle(decision.reservation!, 0.004);
  approx(budget.forDay(), 0.004);
  approx(budget.forCustomer("c1"), 0.004);
});

test("one customer's quota does not block the others", () => {
  const budget = new Budget();
  for (let i = 0; i < 5; i++) budget.settle(budget.reserve("chatty", 0.026).reservation!, 0.026);
  const decision = budget.reserve("chatty", 0.026);
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, "customer_quota");
  assert.ok(budget.reserve("other", 0.026).accepted);
});

test("the calls in progress count", () => {
  // Ten calls started together cannot exceed the ceiling between the ten of them.
  const budget = new Budget();
  const accepted = Array.from({ length: 10 }, (_, i) => budget.reserve(`customer-${i}`, 0.14).accepted);
  assert.equal(accepted.filter(Boolean).length, 9); // 9 × 0.14 = $1.26; the tenth would go beyond $1.30
});

test("release a reservation", () => {
  const budget = new Budget();
  budget.release(budget.reserve("c1", 0.1).reservation!);
  assert.equal(budget.forDay(), 0);
});

test("the alert before the ceiling", () => {
  const budget = new Budget();
  assert.equal(budget.reserve("c1", 0.1).alert, false);
  for (let i = 0; i < 8; i++) budget.reserve(`c${i + 2}`, 0.13);
  assert.ok(budget.onAlert()); // $1.14 committed out of $1.30: more than 80%
});

test("a new day starts from zero, but not the month", () => {
  setConfig({ MONTHLY_BUDGET: 1.5, CUSTOMER_DAILY_QUOTA: 2.0 });
  let instant = new Date("2026-10-20T23:00:00Z");
  const budget = new Budget(":memory:", () => instant);
  budget.reserve("c1", 0.1);
  budget.settle(budget.reserve("c2", 1.1).reservation!, 1.1);
  instant = new Date("2026-10-21T00:30:00Z");
  assert.equal(budget.forDay(), 0);
  approx(budget.forMonth(), 1.2);
  const decision = budget.reserve("c3", 0.4);
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, "monthly_budget");
});

// Chapter 18: the quota per address.

test("the quota per address does not start from zero with a new conversation", () => {
  setConfig({ NETWORK_DAILY_QUOTA: 0.1 });
  const budget = new Budget();
  const accepted = Array.from({ length: 5 }, () => budget.reserve(crypto.randomUUID(), 0.03, "address:196.168.10.20").accepted);
  assert.deepEqual(accepted, [true, true, true, false, false]);
  assert.equal(budget.reserve(crypto.randomUUID(), 0.03, "address:196.168.10.20").reason, "network_quota");
  assert.ok(budget.reserve(crypto.randomUUID(), 0.03, "address:196.168.77.5").accepted); // another address
});

test("an old budget database receives the column", () => {
  const path = join(mkdtempSync(join(tmpdir(), "comptoir-")), "budget.sqlite3");
  const old = new DatabaseSync(path); // the table as chapter 8 created it
  old.exec(
    "CREATE TABLE expenses (id TEXT PRIMARY KEY, day TEXT NOT NULL, month TEXT NOT NULL, customer TEXT NOT NULL, dollars REAL NOT NULL, settled INTEGER NOT NULL)",
  );
  old.close();
  assert.ok(new Budget(path).reserve("c1", 0.01, "address:1.2.3.4").accepted);
});
