// Awa's workshop: sales, stock, recipes, suppliers, events and purchase orders (chapter 13).
//
// The restocking agent reads these data through its tools and proposes a purchase order. Everything that
// can be calculated is calculated here: the sales per week, the item needs, the check and the total of the
// order. The agent does no addition that matters, and it sends nothing: an order stays “to be approved” as
// long as Awa has not approved it herself. The data are those of the Python version
// (python/comptoir/data/workshop/), made once by python/ch13/make_data.py.
//
// The numbers of the JSON files keep their writing (2.0 stays a PyFloat): what the tools read is the same
// text as in the Python version.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readCsv } from "./csv.ts";
import { randomId } from "./database.ts";
import { addDays, mondayOf, readDate } from "./dates.ts";
import { PYTHON } from "./launch.ts";
import { PyFloat, formatG, numberOf, parsePythonJson, pythonJson, repr, str } from "./python.ts";
import { fixed, round } from "./rounding.ts";

export const DATA = join(PYTHON, "comptoir", "data", "workshop");
export const TODAY = "2026-10-19"; //   the Monday of the purchase order, in the story
export const CEILING_FCFA = 250_000; // the most Awa commits on one order, without first talking to her bank
export const HORIZON_DAYS = 60; //      a desired delivery beyond that is not ordered today

export const TO_APPROVE = "to be approved by Awa";
export const APPROVED = "approved by Awa";
export const REJECTED = "rejected by Awa";
export const REPLACED = "replaced";

/** A refused value (Python's ValueError): an unknown product, an order already decided. */
export class InvalidValue extends Error {}

export class InvalidOrder extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join("; "));
  }
}

export interface OrderLine {
  item: string;
  supplier: string;
  quantity: PyFloat;
  unit: string;
  desired_delivery: string;
  price_fcfa: number;
  amount_fcfa: number;
}

/** A purchase order, with the fields of the Python version (the orders file is shared). */
export interface Order {
  code: string;
  lines: OrderLine[];
  total_fcfa: number;
  justification: string;
  alerts: string[];
  status: string;
  created_at: string;
  decision_note: string | null;
}

export interface Offer {
  item: string;
  supplier: string;
  lead_time_days: number;
  minimum: number | PyFloat;
  pack_size: number | PyFloat;
  price_fcfa: number;
}

/** datetime.now().isoformat(timespec="seconds"): local time, without a time zone. */
function now(): string {
  const d = new Date();
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

// --- Writing ------------------------------------------------------------------------------------

/** 136500 -> “136,500 FCFA”, like f"{round(amount):,} FCFA". */
export const fcfa = (amount: number): string => `${String(round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} FCFA`;

/** “unit” -> “units” in the plural; “kg” does not change. */
export const units = (unit: string, quantity: number): string => (quantity >= 2 && (unit === "unit" || unit === "piece") ? `${unit}s` : unit);

/** 2.0 -> “2”, 2.5 -> “2.5”: readable quantities, without false decimals (f"{value:g}"). */
const asNumber = (value: number): string => formatG(value);

/** Python's float(): a number, or a text that writes one; the rest is refused, with the same message. */
function toFloat(value: unknown): number {
  if (typeof value === "number" || value instanceof PyFloat) return numberOf(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && /^\s*[+-]?(\d[\d_]*(\.[\d_]*)?|\.\d[\d_]*)([eE][+-]?\d+)?\s*$/.test(value)) return Number(value.replaceAll("_", ""));
  if (typeof value === "string") throw new InvalidValue(`could not convert string to float: ${repr(value)}`);
  throw new TypeError("float() argument must be a string or a real number");
}

// --- The workshop -------------------------------------------------------------------------------

export class Workshop {
  readonly folder: string;
  readonly today: string;
  readonly ceilingFcfa: number;
  readonly ordersPath: string | null; // null: the orders stay in memory (tests, measurements)
  private readonly theOrders = new Map<string, Order>();

  constructor({ folder = DATA, today = TODAY, ceilingFcfa = CEILING_FCFA, orders = null as string | null } = {}) {
    this.folder = folder;
    this.today = today;
    this.ceilingFcfa = ceilingFcfa;
    this.ordersPath = orders;
    if (orders && existsSync(orders)) for (const o of parsePythonJson(readFileSync(orders, "utf8")) as Order[]) this.theOrders.set(o.code, o);
  }

  private readJson(name: string): Record<string, unknown> {
    return parsePythonJson(readFileSync(join(this.folder, name), "utf8")) as Record<string, unknown>;
  }

  // --- Reading ----------------------------------------------------------------------------------

  /** {monday: {product: {usual, event}}}, calculated on the sales file. */
  weeklySales(): Record<string, Record<string, { usual: number; event: number }>> {
    const weeks = new Map<string, Map<string, { usual: number; event: number }>>();
    for (const line of readCsv(join(this.folder, "sales.csv"))) {
      const day = readDate(line.date!);
      if (!day) throw new InvalidValue(`Invalid isoformat string: ${repr(line.date)}`);
      const monday = mondayOf(day);
      const kind = line.channel === "event" ? "event" : "usual";
      if (!weeks.has(monday)) weeks.set(monday, new Map());
      const products = weeks.get(monday)!;
      if (!products.has(line.product!)) products.set(line.product!, { usual: 0, event: 0 });
      products.get(line.product!)![kind] += Number.parseInt(line.quantity!, 10);
    }
    return Object.fromEntries([...weeks].sort(([a], [b]) => (a < b ? -1 : 1)).map(([w, p]) => [w, Object.fromEntries(p)]));
  }

  products(): string[] {
    return Object.keys(this.recipes().recipes as object);
  }

  /** The table the agent reads: usual sales per week, averages, and event orders set apart. */
  salesSummary(): string {
    const weeks = this.weeklySales();
    const products = this.products();
    const usual = (v: Record<string, { usual: number }>, p: string): number => v[p]?.usual ?? 0;
    const lines = ["Usual sales per week (bottles or flasks), event orders excluded:"];
    for (const [monday, sales] of Object.entries(weeks)) lines.push(`- week of ${monday}: ` + products.map((p) => `${p} ${usual(sales, p)}`).join(", "));
    const all = Object.values(weeks);
    const last = all.slice(-4);
    lines.push("Averages per week (calculated by the code):");
    for (const p of products) {
      const over8 = all.reduce((s, v) => s + usual(v, p), 0) / all.length;
      const over4 = last.reduce((s, v) => s + usual(v, p), 0) / last.length;
      lines.push(`- ${p}: ${fixed(over8, 1)} over 8 weeks, ${fixed(over4, 1)} over the last 4`);
    }
    const events = Object.entries(weeks).flatMap(([monday, v]) => Object.entries(v).filter(([, n]) => n.event).map(([p, n]) => `week of ${monday}, ${p} ${n.event}`));
    lines.push("Past event orders (one-off): " + (events.join("; ") || "none"));
    return lines.join("\n");
  }

  stock(): Record<string, unknown> {
    return this.readJson("stock.json");
  }

  recipes(): Record<string, unknown> {
    return this.readJson("recipes.json");
  }

  offers(): Offer[] {
    return this.readJson("suppliers.json").offers as Offer[];
  }

  events(): unknown[] {
    return this.readJson("events.json").events as unknown[];
  }

  supplierMessages(): string {
    return readFileSync(join(this.folder, "supplier-messages.md"), "utf8").replace(/\r\n?/g, "\n");
  }

  unit(item: string): string {
    return (this.recipes().units as Record<string, string>)[item] ?? "unit";
  }

  // --- Calculations -----------------------------------------------------------------------------

  /**
   * What a production (bottles or flasks per product) requires, minus the stock of items, and, for each
   * offer, the quantity to order that respects the minimum and the pack size.
   */
  needs(production: Record<string, number>): Record<string, unknown>[] {
    const recipes = this.recipes().recipes as Record<string, Record<string, number | PyFloat>>;
    const unknown = Object.keys(production).filter((p) => !(p in recipes));
    if (unknown.length) throw new InvalidValue(`unknown products: ${unknown.join(", ")}; known products: ${this.products().join(", ")}`);
    const gross = new Map<string, number>(); // floats in Python: 0.0 + 90 is 90.0
    for (const [product, count] of Object.entries(production)) {
      for (const [item, perUnit] of Object.entries(recipes[product]!)) gross.set(item, (gross.get(item) ?? 0) + numberOf(perUnit) * count);
    }
    const inStock = this.stock().items as Record<string, number | PyFloat>;
    const offers = this.offers();
    return [...gross].map(([item, need]) => {
      const stock = inStock[item] ?? 0;
      const net = Math.max(0, need - numberOf(stock));
      const suggestions = offers
        .filter((o) => o.item === item)
        .map((o) => {
          let quantity: number | PyFloat = 0;
          if (net !== 0) {
            // max(minimum, ceil(...) × pack_size): the second, if it is larger; a float if the pack size is one.
            const product = Math.ceil(net / numberOf(o.pack_size) - 1e-9) * numberOf(o.pack_size);
            quantity = product > numberOf(o.minimum) ? (o.pack_size instanceof PyFloat ? new PyFloat(product) : product) : o.minimum;
          }
          return { supplier: o.supplier, quantity, amount_fcfa: round(numberOf(quantity) * o.price_fcfa) };
        });
      return {
        item,
        unit: this.unit(item),
        need: new PyFloat(round(need, 3)),
        stock,
        net_need: new PyFloat(round(net, 3)),
        to_order_per_sheets: suggestions,
      };
    });
  }

  /** The errors of a draft order; an empty list if it respects the sheets and the ceiling. */
  check(lines: Record<string, unknown>[]): string[] {
    if (!lines.length) return ["the order contains no line"];
    const errors: string[] = [];
    const seen = new Set<string>();
    const offers = this.offers();
    let total = 0;
    lines.forEach((line, rank) => {
      const i = rank + 1;
      const { item, supplier } = line;
      const offer = offers.find((o) => o.item === item && o.supplier === supplier);
      if (!offer) {
        const sellers = offers.filter((o) => o.item === item).map((o) => o.supplier);
        errors.push(`line ${i}: ${repr(supplier)} does not sell ${repr(item)}` + (sellers.length ? ` (suppliers of this item: ${sellers.join(", ")})` : " (unknown item)"));
        return;
      }
      const quantity = toFloat(line.quantity || 0);
      const packSize = numberOf(offer.pack_size);
      if (quantity < numberOf(offer.minimum)) {
        errors.push(`line ${i}: ${asNumber(quantity)} ${str(item)}, below the minimum of ${str(offer.minimum)} at ${str(supplier)}`);
      } else if (Math.abs(quantity / packSize - round(quantity / packSize)) > 1e-9) {
        const unit = this.unit(String(item));
        errors.push(`line ${i}: ${str(supplier)} sells ${str(item)} in units of ${str(offer.pack_size)}` + (unit === "unit" || unit === "piece" ? "" : ` ${unit}`));
      }
      const delivery = readDate(str(line.desired_delivery ?? null));
      if (delivery === null) {
        errors.push(`line ${i}: unreadable delivery date (${repr(line.desired_delivery)}), expected format YYYY-MM-DD`);
      } else {
        const earliest = addDays(this.today, offer.lead_time_days);
        if (delivery < earliest) {
          errors.push(`line ${i}: delivery on ${delivery} impossible, ${str(supplier)}'s lead time is ${offer.lead_time_days} days (at the earliest ${earliest})`);
        } else if (delivery > addDays(this.today, HORIZON_DAYS)) {
          errors.push(`line ${i}: delivery on ${delivery}, too far away to order it today`);
        }
        const key = JSON.stringify([item, supplier, delivery]);
        if (seen.has(key)) errors.push(`line ${i}: duplicate (${str(item)}, ${str(supplier)}, ${delivery})`);
        seen.add(key);
      }
      total += quantity * offer.price_fcfa;
    });
    if (total > this.ceilingFcfa) errors.push(`total of ${fcfa(total)}, above the ceiling of ${fcfa(this.ceilingFcfa)} set by Awa`);
    return errors;
  }

  // --- The purchase order -----------------------------------------------------------------------

  /**
   * Records a draft order, to be approved by Awa. Raises InvalidOrder if the sheets are not respected.
   * Nothing is sent to a supplier: it is Awa who sends an approved order.
   */
  propose(lines: Record<string, unknown>[], justification: string, alerts: string[] | null = null): Order {
    const errors = this.check(lines);
    if (errors.length) throw new InvalidOrder(errors);
    const offers = this.offers();
    const detail: OrderLine[] = lines.map((line) => {
      const offer = offers.find((o) => o.item === line.item && o.supplier === line.supplier)!;
      const quantity = toFloat(line.quantity);
      return {
        item: String(line.item),
        supplier: String(line.supplier),
        quantity: new PyFloat(quantity),
        unit: this.unit(String(line.item)),
        desired_delivery: str(line.desired_delivery),
        price_fcfa: offer.price_fcfa,
        amount_fcfa: round(quantity * offer.price_fcfa),
      };
    });
    const order: Order = {
      code: `BC-${randomId().slice(0, 6)}`,
      lines: detail,
      total_fcfa: detail.reduce((s, l) => s + l.amount_fcfa, 0),
      justification,
      alerts: [...(alerts ?? [])],
      status: TO_APPROVE,
      created_at: now(),
      decision_note: null,
    };
    this.theOrders.set(order.code, order);
    this.save();
    return order;
  }

  /** A draft order that the agent replaces with another, in the same session: it is no longer to be approved. */
  withdraw(code: string, replacedBy: string): void {
    const order = this.orderOf(code);
    if (order.status === TO_APPROVE) {
      order.status = `${REPLACED} by ${replacedBy}`;
      this.save();
    }
  }

  /** Awa's decision, outside the agent: the only way to take an order out of “to be approved”. */
  decide(code: string, approved: boolean, note: string | null = null): Order {
    const order = this.orderOf(code);
    if (order.status !== TO_APPROVE) throw new InvalidValue(`order ${code} is already ${order.status}`);
    order.status = approved ? APPROVED : REJECTED;
    order.decision_note = note;
    this.save();
    return order;
  }

  orders(): Order[] {
    return [...this.theOrders.values()];
  }

  private orderOf(code: string): Order {
    const order = this.theOrders.get(code);
    if (!order) throw new Error(repr(code)); // a KeyError in Python
    return order;
  }

  private save(): void {
    if (!this.ordersPath) return;
    mkdirSync(dirname(this.ordersPath), { recursive: true });
    writeFileSync(this.ordersPath, pythonJson(this.orders(), 2), "utf8"); // json.dumps(…, indent=2)
  }
}

export function renderOrder(order: Order): string {
  const lines = [`Order ${order.code} — ${order.status} — total ${fcfa(order.total_fcfa)}`];
  for (const l of order.lines) {
    const q = numberOf(l.quantity);
    lines.push(`- ${asNumber(q)} ${units(l.unit, q)} of ${l.item} from ${l.supplier}, delivery on ${l.desired_delivery}: ${fcfa(l.amount_fcfa)}`);
  }
  if (order.alerts.length) lines.push("Alerts: " + order.alerts.join(" | "));
  return lines.join("\n");
}

// The dates are also exported from here, where the scripts of chapter 13 take them.
export { addDays, mondayOf, readDate } from "./dates.ts";
