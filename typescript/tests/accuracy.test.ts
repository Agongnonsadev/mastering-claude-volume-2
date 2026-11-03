// Measure accuracy: each field correct, missed, invented or wrong (python/tests/test_accuracy.py).

import assert from "node:assert/strict";
import { test } from "node:test";
import { Gap, compare, summarize } from "../comptoir/accuracy.ts";

const EXPECTED = {
  customer: "Mrs. Dossou",
  neighborhood: "Cadjèhoun",
  total_read: null,
  lines: [
    { product: "Soursop juice", quantity: null, unit_price_read: 1000 },
    { product: "Ginger juice", quantity: 3, unit_price_read: 1000 },
  ],
};

test("the four outcomes", () => {
  assert.equal(new Gap("d", "f", "Cadjèhoun", "cadjehoun").outcome, "correct"); // case and accents ignored
  assert.equal(new Gap("d", "f", 3, null).outcome, "missed");
  assert.equal(new Gap("d", "f", null, 12).outcome, "invented");
  assert.equal(new Gap("d", "f", 3, 8).outcome, "wrong");
  assert.equal(new Gap("d", "f", null, null).outcome, "correct"); // “illegible” expected, “illegible” returned
});

test("a stained quantity guessed is an invented value", () => {
  const obtained = { ...EXPECTED, lines: [{ ...EXPECTED.lines[0]!, quantity: 12 }, EXPECTED.lines[1]!] };
  const outcomes = new Map(compare("order-03.jpg", EXPECTED, obtained).map((g) => [g.field, g.outcome]));
  assert.equal(outcomes.get("lines.0.quantity"), "invented");
  assert.equal([...outcomes.values()].filter((o) => o === "correct").length, outcomes.size - 1);
});

test("a failed extraction misses everything", () => {
  const s = summarize(compare("order-03.jpg", EXPECTED, null));
  // The fields expected as null are “correct”: a failure does not invent them.
  assert.equal(s.missed, 7);
  assert.equal(s.invented, 0);
});

test("a line read in excess is invented", () => {
  const obtained = { ...EXPECTED, lines: [...EXPECTED.lines, { product: "Bissap juice", quantity: 2 }] };
  assert.equal(compare("order-03.jpg", EXPECTED, obtained).at(-1)!.outcome, "invented");
});
