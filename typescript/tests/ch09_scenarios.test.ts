// The 10 scenarios of the challenge, and the checks made by the code (python/tests/test_ch09_scenarios.py).

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Scenario, announcesAnOrder, check, load, replaceCodes } from "../ch09/play_scenarios.ts";
import { Shop } from "../comptoir/shop.ts";

test("ten scenarios, including the three traps", () => {
  const ids = load().map((s) => s.id);
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, 10);
  for (const trap of ["trap-nonexistent-product", "trap-insufficient-stock", "trap-change-of-mind"]) assert.ok(ids.includes(trap));
});

test("an announcement of an order by Claude is detected", () => {
  assert.ok(announcesAnOrder("Perfect, your order is recorded!"));
  assert.ok(announcesAnOrder("Your order has been confirmed."));
  assert.ok(announcesAnOrder("Parfait, votre commande est bien enregistrée !"));
  assert.ok(!announcesAnOrder("Your order is not recorded yet: reply with the code."));
  assert.ok(!announcesAnOrder("Check the summary before confirming."));
});

test("the check of a scenario", () => {
  const scenario: Scenario = { id: "trial", messages: [], expected: { orders: 1, required_tools: ["order_prepare"], passed_on: null } };
  const shop = new Shop();
  const code = shop.prepare("c1", [{ product: "Bissap juice", quantity: 6 }], "A", "B").confirmation_code;
  assert.deepEqual(check(scenario, shop, "c1", ["order_prepare"], ["Check it."]), ["0 order(s) created, 1 expected"]);
  shop.confirm("c1", code);
  assert.deepEqual(check(scenario, shop, "c1", ["order_prepare"], ["Check it."]), []);
});

test("the codes are replaced by those of the shop", () => {
  const shop = new Shop();
  assert.equal(replaceCodes("YES {code}", shop, "c1"), null); // no summary yet
  const code = shop.prepare("c1", [{ product: "Bissap juice", quantity: 6 }], "A", "B").confirmation_code;
  assert.equal(replaceCodes("YES {code}", shop, "c1"), `YES ${code}`);
});
