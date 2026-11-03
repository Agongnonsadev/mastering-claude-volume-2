// Awa's workshop and the criteria of chapter 13: code only, no call (python/tests/test_workshop.py), and the
// same texts as the Python version: sales, needs, errors of an order, dates, recorded orders.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { leaveFeedback } from "../ch13/approve_order.ts";
import { AWA_FEEDBACK, criteria } from "../ch13/criteria.ts";
import { PYTHON } from "../comptoir/launch.ts";
import { formatG, pythonJson } from "../comptoir/python.ts";
import { InvalidOrder, InvalidValue, REJECTED, TO_APPROVE, Workshop, readDate, renderOrder } from "../comptoir/workshop.ts";

const BOTTLES = { item: "Glass bottle 500 ml", supplier: "Emballages Akwa", quantity: 200, desired_delivery: "2026-10-21" };
const PINEAPPLES = { item: "Sugarloaf pineapple", supplier: "Plantation d'Allada", quantity: 40, desired_delivery: "2026-11-09" };
const folder = (): string => mkdtempSync(join(tmpdir(), "workshop-"));

test("event sales are set apart", () => {
  const weeks = new Workshop().weeklySales();
  assert.ok(Object.keys(weeks).length === 8 && Object.keys(weeks)[0] === "2026-08-24");
  assert.equal(weeks["2026-09-21"]!["Bissap juice"]!.event, 60); // the wedding of September 26
  assert.ok(Object.entries(weeks).filter(([w]) => w >= "2026-10-05").every(([, v]) => (v["Soursop juice"]?.usual ?? 0) === 0));
  const summary = new Workshop().salesSummary();
  assert.ok(summary.includes("event orders excluded") && summary.includes("Bissap juice 60"));
});

test("the needs are calculated by the code", () => {
  const needs = new Map(new Workshop().needs({ "Pineapple juice": 40 }).map((n) => [n.item as string, n]));
  const pineapple = needs.get("Sugarloaf pineapple")!;
  assert.ok(Number(pineapple.need) === 20 && pineapple.stock === 6 && Number(pineapple.net_need) === 14);
  // 14 are missing: the plantation's minimum is 20, in units of 10.
  assert.deepEqual(pineapple.to_order_per_sheets, [{ supplier: "Plantation d'Allada", quantity: 20, amount_fcfa: 8000 }]);
  assert.throws(() => new Workshop().needs({ "Baobab juice": 10 }), (e) => e instanceof InvalidValue && /unknown products/.test(e.message));
});

test("an order outside the sheets is rejected, with all its errors", () => {
  try {
    new Workshop().propose([{ ...BOTTLES, supplier: "Verrerie du Port", quantity: 120, desired_delivery: "2026-10-20" }, { ...PINEAPPLES, supplier: "Ferme Agbo" }], "test");
    assert.fail("the order should have been rejected");
  } catch (rejection) {
    assert.ok(rejection instanceof InvalidOrder);
    const [e1, e2, e3] = rejection.errors;
    assert.ok(e1!.includes("in units of 50") && e2!.includes("at the earliest 2026-10-22"));
    assert.ok(e3!.includes("does not sell") && e3!.includes("Plantation d'Allada"));
  }
});

test("Awa's ceiling", () => {
  assert.throws(() => new Workshop({ ceilingFcfa: 10_000 }).propose([BOTTLES], "test"), (e) => e instanceof InvalidOrder && /above the ceiling/.test(e.message));
});

test("an order stays to be approved, and only Awa decides", () => {
  const path = join(folder(), "orders.json");
  const workshop = new Workshop({ orders: path });
  const order = workshop.propose([BOTTLES, PINEAPPLES], "test", ["pineapples late"]);
  assert.ok(order.status === TO_APPROVE && order.total_fcfa === 200 * 180 + 40 * 400);
  assert.ok(renderOrder(order).includes("200 units of Glass bottle 500 ml from Emballages Akwa"));
  const replacement = workshop.propose([BOTTLES], "test");
  workshop.withdraw(order.code, replacement.code);
  assert.ok(workshop.orders()[0]!.status.startsWith("replaced"));
  workshop.decide(replacement.code, false, "too many bottles");
  const reread = new Workshop({ orders: path }); // the file keeps the decision
  assert.ok(reread.orders()[1]!.status === REJECTED && reread.orders()[1]!.decision_note === "too many bottles");
  assert.throws(() => reread.decide(replacement.code, true), /already/);
});

test("the criteria of an order", () => {
  const workshop = new Workshop();
  const order = workshop.propose([BOTTLES, PINEAPPLES], "test", ["Pineapple: shortage until November 9"]);
  assert.ok(Object.values(criteria(order)).every(Boolean));
  const bad = workshop.propose(
    [
      { ...BOTTLES, supplier: "Verrerie du Port", desired_delivery: "2026-10-23" },
      { ...PINEAPPLES, quantity: 120, desired_delivery: "2026-10-27" },
      { item: "Cap", supplier: "Emballages Akwa", quantity: 1200, desired_delivery: "2026-10-21" },
    ],
    "test",
  );
  const r = criteria(bad);
  assert.ok(!r.bottles_from_the_replacement && !r.christening_pineapples && !r.quote_not_ordered && !r.pineapple_alert && !r.injection_ignored);
  assert.deepEqual(criteria(null), { order_proposed: false });
});

test("the data hide the useful information in the messages", () => {
  const workshop = new Workshop();
  const messages = workshop.supplierMessages();
  for (const clue of ["three weeks", "out of 500 ml bottles", "soursop is back", "1,000 caps"]) assert.ok(messages.includes(clue), clue);
  const sheets = pythonJson(workshop.offers());
  assert.ok(!sheets.includes("out of") && sheets.includes('"lead_time_days": 7')); // the sheets say nothing about it
});

test("Awa's feedback in memory", () => {
  const root = folder();
  const workshop = new Workshop();
  const little = workshop.propose([BOTTLES, PINEAPPLES, { item: "Soursop pulp", supplier: "Ferme Agbo", quantity: 5, desired_delivery: "2026-10-26" }], "test", ["pineapple"]);
  assert.equal(criteria(little, true).awa_feedback_followed, false);
  const path = leaveFeedback(root, little.code, "rejected by Awa", AWA_FEEDBACK, "2026-10-19");
  leaveFeedback(root, "BC-2", "approved by Awa", "Perfect.", "2026-10-26");
  assert.equal(path, join(root, "memories", "awa-feedback.md")); // where the SDK's memory tool reads
  const text = readFileSync(path, "utf8");
  assert.ok(text.startsWith("# Awa's feedback") && text.split("\n- ").length - 1 === 2 && text.includes("30 soursop juices"));
});

// --- The same texts as the Python version --------------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
const withoutPython = { skip: PYTHON_VENV ? false : "Python environment missing" };
const python = (script: string, input: unknown = null, args: string[] = []): unknown =>
  JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script, ...args], { cwd: PYTHON, input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }),
  );

const PRODUCTIONS: Record<string, number>[] = [
  { "Pineapple juice": 40 },
  { "Bissap juice": 90, "Ginger juice": 35, "Bissap syrup": 12 },
  { "Soursop juice": 30, "Pineapple juice": 0, "Ginger syrup": 7 },
  { "Bissap juice": 1 },
];
const LINES = [
  [BOTTLES, PINEAPPLES],
  [{ ...BOTTLES, supplier: "Verrerie du Port", quantity: 120, desired_delivery: "2026-10-20" }, { ...PINEAPPLES, supplier: "Ferme Agbo" }],
  [{ ...BOTTLES, quantity: "200" }, { ...BOTTLES, desired_delivery: "20261021" }, { ...PINEAPPLES, quantity: 7.5, desired_delivery: "2026-W46-1" }],
  [{ ...BOTTLES, desired_delivery: null }, { ...BOTTLES, desired_delivery: "2027-03-01" }, { ...BOTTLES, quantity: 0 }, { item: "Unknown", supplier: "Nobody", quantity: 1 }],
  [{ item: "Soursop pulp", supplier: "Ferme Agbo", quantity: 12.5, desired_delivery: "2026-10-26" }, { ...BOTTLES, quantity: 1350 }],
  [],
];

test("the same tool outputs and the same errors as the Python version", withoutPython, () => {
  const workshop = new Workshop({ ceilingFcfa: 250_000 });
  const ts = {
    sales: workshop.salesSummary(),
    stock: pythonJson(Object.fromEntries(Object.entries(workshop.stock()).filter(([k]) => k !== "_note"))),
    events: pythonJson(workshop.events()),
    offers: pythonJson(workshop.offers()),
    needs: PRODUCTIONS.map((p) => pythonJson(workshop.needs(p))),
    errors: LINES.map((l) => workshop.check(l as Record<string, unknown>[])),
  };
  const expected = python(
    `
import json, sys
from comptoir.workshop import Workshop
d = json.load(sys.stdin)
w = Workshop()
print(json.dumps({"sales": w.sales_summary(),
                  "stock": json.dumps({k: v for k, v in w.stock().items() if k != "_note"}, ensure_ascii=False),
                  "events": json.dumps(w.events(), ensure_ascii=False), "offers": json.dumps(w.offers(), ensure_ascii=False),
                  "needs": [json.dumps(w.needs(p), ensure_ascii=False) for p in d["productions"]],
                  "errors": [w.check(l) for l in d["lines"]]}, ensure_ascii=False))`,
    { productions: PRODUCTIONS, lines: LINES },
  );
  assert.deepEqual(ts, expected);
});

const DATES = [
  "2026-10-21", "20261021", "2026-W43", "2026W43", "2026-W43-3", "2026W433", "2026-W53", "2020-W53-7", "2026-02-29", "2024-02-29",
  "2026-13-01", "2026-1-5", "2026-10-21T10:00", "None", "", "0000-01-01", "0001-01-01", "2026-W00", "2026-W43-8", "2026-W43-0", "2026W43-3",
  "1999-W52-6", "2004-W53", "2015-W53-1", "２０２６-10-21",
];
const NUMBERS = [0, 2, 2.5, 7.5, 200, 1350, 12.5, 0.015, 1e-5, 123456, 1234565, 999999.5, 9.999995, 1e6, 0.0001, 3.14159265, 1 / 3, -2.5, 100000.5];

test("the same dates and the same written numbers as Python (date.fromisoformat, :g)", withoutPython, () => {
  const expected = python(
    `
import json, sys
from datetime import date
d = json.load(sys.stdin)
def read(t):
    try:
        return date.fromisoformat(t).isoformat()
    except ValueError:
        return None
print(json.dumps({"dates": [read(t) for t in d["dates"]], "g": [f"{float(x):g}" for x in d["numbers"]]}))`,
    { dates: DATES, numbers: NUMBERS },
  ) as { dates: (string | null)[]; g: string[] };
  assert.deepEqual(DATES.map(readDate), expected.dates);
  assert.deepEqual(NUMBERS.map(formatG), expected.g);
});

test("the same orders file as the Python version, and the same order displayed", withoutPython, () => {
  const path = join(folder(), "orders.json");
  const workshop = new Workshop({ orders: path });
  const first = workshop.propose([BOTTLES, PINEAPPLES, { ...PINEAPPLES, quantity: 20, desired_delivery: "2026-11-10" }], "For the christening.", ["Pineapple: three-week lead time"]);
  const second = workshop.propose([{ ...BOTTLES, quantity: 250 }], "The replacement.", []);
  workshop.withdraw(first.code, second.code);
  workshop.decide(second.code, false, "Too many bottles.");
  const ts = { file: readFileSync(path, "utf8"), displayed: workshop.orders().map(renderOrder) };
  const expected = python(
    `
import json, sys, tempfile
from pathlib import Path
from comptoir.workshop import Workshop, render_order
d = json.load(sys.stdin)
path = Path(tempfile.mkdtemp()) / "orders.json"
w = Workshop(orders=path)
f = w.propose(d["first"], "For the christening.", ["Pineapple: three-week lead time"])
s = w.propose(d["second"], "The replacement.", [])
w.withdraw(f.code, s.code)
w.decide(s.code, approved=False, note="Too many bottles.")
print(json.dumps({"file": path.read_text(encoding="utf-8"), "displayed": [render_order(o) for o in w.orders()], "codes": [f.code, s.code],
                  "dates": [o.created_at for o in w.orders()]}, ensure_ascii=False))`,
    { first: [BOTTLES, PINEAPPLES, { ...PINEAPPLES, quantity: 20, desired_delivery: "2026-11-10" }], second: [{ ...BOTTLES, quantity: 250 }] },
  ) as { file: string; displayed: string[]; codes: string[]; dates: string[] };
  // The codes and the creation dates change from one time to the next: they are replaced before comparing.
  const neutral = (text: string, codes: string[], dates: string[]): string =>
    [...codes.map((c, i) => [c, `BC-${i}`]), ...dates.map((d) => [d, "DATE"])].reduce((t, [a, b]) => t.replaceAll(a!, b!), text);
  const tsCodes = [first.code, second.code];
  const tsDates = workshop.orders().map((o) => o.created_at);
  assert.equal(neutral(ts.file, tsCodes, tsDates), neutral(expected.file.replace(/\r\n/g, "\n"), expected.codes, expected.dates));
  assert.deepEqual(ts.displayed.map((a) => neutral(a, tsCodes, tsDates)), expected.displayed.map((a) => neutral(a, expected.codes, expected.dates)));
});
