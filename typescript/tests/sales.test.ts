// The week's sales: a fixed export, and our reference calculation to check the report
// (python/tests/test_sales.py), and the same calculation as the Python version.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PYTHON } from "../comptoir/launch.ts";
import { type Totals, compare, read, totals } from "../comptoir/sales.ts";

const SALES = join(PYTHON, "ch10", "data", "sales-2026-10-12.csv");

test("the export is in the repository", () => {
  const lines = read(SALES);
  assert.equal(lines.length, 77);
  assert.ok(lines.every((l) => Number.isInteger(l.quantity) && Number.isInteger(l.unit_price_fcfa)));
});

test("the reference totals", () => {
  const t = totals(read(SALES));
  assert.ok(t.revenue_fcfa === 394_000 && t.orders === 37);
  assert.equal(t.average_basket_fcfa, 10_649);
  const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
  assert.equal(sum(Object.values(t.by_day)), t.revenue_fcfa);
  assert.equal(sum(Object.values(t.by_neighborhood)), t.revenue_fcfa);
  assert.equal(sum(Object.values(t.by_product).map((p) => p.amount_fcfa)), t.revenue_fcfa);
});

test("the comparison finds a gap and tolerates a rounding", () => {
  const t = totals(read(SALES));
  assert.deepEqual(compare(t, t), []);
  assert.deepEqual(compare({ ...t, average_basket_fcfa: t.average_basket_fcfa + 1 }, t), []); // different rounding
  const wrong = { ...t, by_day: { ...t.by_day, "2026-10-12": 1 } };
  assert.deepEqual(compare(wrong, t), [`by_day[2026-10-12]: 1 instead of ${t.by_day["2026-10-12"]}`]);
});

test("an extra key in a product is a gap, as in Python", () => {
  const t = totals(read(SALES));
  const [product, values] = Object.entries(t.by_product)[0]!;
  const wrong = { ...t, by_product: { ...t.by_product, [product]: { ...values, discount: 0 } } };
  assert.deepEqual(compare(wrong, t), [
    `by_product[${product}]: {'quantity': ${values.quantity}, 'amount_fcfa': ${values.amount_fcfa}, 'discount': 0} instead of {'quantity': ${values.quantity}, 'amount_fcfa': ${values.amount_fcfa}}`,
  ]);
});

test("the calculation on a small export", () => {
  const path = join(mkdtempSync(join(tmpdir(), "sales-")), "small.csv");
  writeFileSync(
    path,
    "date,order,product,quantity,unit_price_fcfa,neighborhood,channel\n" +
      "2026-10-12,C-1,Bissap juice,2,1000,Zogbo,whatsapp\n2026-10-12,C-1,Bissap syrup,1,2500,Zogbo,whatsapp\n",
    "utf8",
  );
  const t = totals(read(path));
  assert.ok(t.revenue_fcfa === 4500 && t.orders === 1);
});

// --- The same calculation as the Python version --------------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

test("the same totals and the same gaps as the Python version", { skip: PYTHON_VENV ? false : "Python environment missing" }, () => {
  const t = totals(read(SALES));
  const days = Object.keys(t.by_day);
  const products = Object.keys(t.by_product);
  // A summary wrong in many ways: a text instead of a number, a missing day and product, an invented
  // neighborhood, a wrong quantity, a basket outside the tolerance.
  const wrong: Record<string, unknown> = {
    revenue_fcfa: String(t.revenue_fcfa),
    orders: t.orders - 1,
    average_basket_fcfa: t.average_basket_fcfa + 2,
    by_day: Object.fromEntries(days.slice(1).map((d) => [d, t.by_day[d]])),
    by_neighborhood: { ...t.by_neighborhood, "Trial neighborhood": 5 },
    by_product: {
      ...Object.fromEntries(products.slice(1).map((p) => [p, t.by_product[p]])),
      [products[1]!]: { quantity: 0, amount_fcfa: t.by_product[products[1]!]!.amount_fcfa },
    },
  };
  const script = `
import json, sys
from comptoir.sales import compare, read, totals
t = totals(read(sys.argv[1]))
print(json.dumps({"totals": t, "gaps": compare(json.load(sys.stdin), t)}, ensure_ascii=False))`;
  const python = JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script, SALES], { cwd: PYTHON, input: JSON.stringify(wrong), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }),
  ) as { totals: Totals; gaps: string[] };
  assert.equal(JSON.stringify(t), JSON.stringify(python.totals)); // the same keys, in the same order
  const gaps = compare(wrong as Partial<Totals>, t);
  assert.ok(gaps.length >= 5);
  assert.deepEqual(gaps, python.gaps);
});
