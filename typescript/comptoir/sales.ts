// A week's sales, calculated by our code: the report's reference (chapter 10).
//
// Claude calculates the report in its container; this module redoes the same calculations, here, to check
// each figure before Awa reads it.

import { readCsv } from "./csv.ts";
import { equal, repr } from "./python.ts";
import { round } from "./rounding.ts";

export interface Sale {
  date: string;
  order: string;
  product: string;
  quantity: number;
  unit_price_fcfa: number;
  neighborhood: string;
  channel: string;
}

export function read(path: string): Sale[] {
  return readCsv(path).map((l) => ({ ...l, quantity: Number(l.quantity), unit_price_fcfa: Number(l.unit_price_fcfa) }) as Sale);
}

export interface Totals {
  revenue_fcfa: number;
  orders: number;
  average_basket_fcfa: number;
  by_product: Record<string, { quantity: number; amount_fcfa: number }>;
  by_day: Record<string, number>;
  by_neighborhood: Record<string, number>;
}

/** The keys of an object in alphabetical order, like dict(sorted(...)) in Python. */
const sorted = <T>(obj: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function totals(lines: Sale[]): Totals {
  const byProduct: Totals["by_product"] = {};
  const byDay: Record<string, number> = {};
  const byNeighborhood: Record<string, number> = {};
  for (const l of lines) {
    const amount = l.quantity * l.unit_price_fcfa;
    const p = (byProduct[l.product] ??= { quantity: 0, amount_fcfa: 0 });
    p.quantity += l.quantity;
    p.amount_fcfa += amount;
    byDay[l.date] = (byDay[l.date] ?? 0) + amount;
    byNeighborhood[l.neighborhood] = (byNeighborhood[l.neighborhood] ?? 0) + amount;
  }
  const total = Object.values(byDay).reduce((a, b) => a + b, 0);
  const orders = new Set(lines.map((l) => l.order)).size;
  return {
    revenue_fcfa: total,
    orders,
    average_basket_fcfa: orders ? round(total / orders) : 0,
    by_product: sorted(byProduct),
    by_day: sorted(byDay),
    by_neighborhood: sorted(byNeighborhood),
  };
}

/** The gaps between the summary produced by Claude and our calculation. Empty list: everything matches. */
export function compare(read: Partial<Totals> | Record<string, unknown>, expected: Totals): string[] {
  const summary = read as Record<string, unknown>; // read from summary.json: nothing is guaranteed there
  const gaps: string[] = [];
  for (const key of ["revenue_fcfa", "orders"] as const) {
    if (!equal(summary[key], expected[key])) gaps.push(`${key}: ${repr(summary[key])} instead of ${expected[key]}`);
  }
  if (Math.abs(((summary.average_basket_fcfa as number) || 0) - expected.average_basket_fcfa) > 1) { // the rounding may differ
    gaps.push(`average_basket_fcfa: ${repr(summary.average_basket_fcfa)} instead of ${expected.average_basket_fcfa}`);
  }
  for (const key of ["by_day", "by_neighborhood"] as const) {
    const got = (summary[key] || {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(expected[key])) {
      if (!equal(got[name], value)) gaps.push(`${key}[${name}]: ${repr(got[name])} instead of ${value}`);
    }
  }
  const got = (summary.by_product || {}) as Record<string, unknown>;
  for (const [product, values] of Object.entries(expected.by_product)) {
    if (!equal(got[product], values)) gaps.push(`by_product[${product}]: ${repr(got[product])} instead of ${repr(values)}`);
  }
  return gaps;
}
