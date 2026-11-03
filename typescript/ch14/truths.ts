// Chapter 14: the right answers to Yao's questions, calculated by the code on the copy.
//
// Before asking Claude anything, we know what it must find: that is what makes it possible to check its
// answers, and not to believe them. The copy is that of the Python version
// (python/customer_data/orders_exploration.sqlite3, made by python/ch14/make_orders.py).

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { round } from "../comptoir/rounding.ts";
import { ROOT } from "./servers.ts";

export const COPY = join(ROOT, "customer_data", "orders_exploration.sqlite3");
// The last four complete weeks of the history: from Monday September 21 to Sunday October 18.
export const PERIOD_START = "2026-09-21";
export const PERIOD_END = "2026-10-19";

export interface Truths {
  neighborhoods: { neighborhood: string; orders: number; fcfa: number }[];
  conversations: number;
  abandonments: number;
  abandonment_share: number;
  worst_abandonment_hour: number;
  worst_hour_rate: number;
  soursop_bottles: number;
}

const open = (path: string): DatabaseSync => new DatabaseSync(path, { readOnly: true });

export function compute(path = COPY): Truths {
  const db = open(path);
  try {
    const neighborhoods = db
      .prepare(
        "SELECT s.neighborhood AS neighborhood, COUNT(*) AS orders, SUM(o.total) AS fcfa FROM orders o JOIN summaries s " +
          "ON s.id = o.summary WHERE o.created_at >= ? AND o.created_at < ? " +
          "GROUP BY s.neighborhood ORDER BY SUM(o.total) DESC LIMIT 3",
      )
      .all(PERIOD_START, PERIOD_END) as Truths["neighborhoods"];
    // An abandoned conversation: summaries, and none of them became an order.
    const { conversations, abandonments } = db
      .prepare(
        "SELECT COUNT(*) AS conversations, SUM(confirmed = 0) AS abandonments FROM (SELECT conversation, MAX(status = 'confirmed') AS confirmed " +
          "FROM summaries GROUP BY conversation)",
      )
      .get() as { conversations: number; abandonments: number };
    const hours = db
      .prepare(
        "SELECT CAST(substr(created_at, 12, 2) AS INTEGER) AS h, COUNT(*) AS n, SUM(status = 'pending') AS pending " +
          "FROM summaries WHERE status != 'replaced' GROUP BY h HAVING COUNT(*) >= 20 " +
          "ORDER BY 1.0 * SUM(status = 'pending') / COUNT(*) DESC LIMIT 1",
      )
      .get() as { h: number; n: number; pending: number };
    const { soursop } = db
      .prepare(
        "SELECT SUM(json_extract(j.value, '$.quantity')) AS soursop FROM orders o JOIN summaries s " +
          "ON s.id = o.summary, json_each(s.lines) j " +
          "WHERE json_extract(j.value, '$.product') = 'Soursop juice'",
      )
      .get() as { soursop: number };
    return {
      neighborhoods: neighborhoods.map((n) => ({ neighborhood: n.neighborhood, orders: n.orders, fcfa: n.fcfa })),
      conversations,
      abandonments,
      abandonment_share: round((100 * abandonments) / conversations, 1),
      worst_abandonment_hour: hours.h,
      worst_hour_rate: round((100 * hours.pending) / hours.n, 1),
      soursop_bottles: soursop,
    };
  } finally {
    db.close();
  }
}

/** The bottles of a product sold between two dates (end excluded), in total and per neighborhood. */
export function bottles(product: string, start: string, end: string, path = COPY): { total: number; by_neighborhood: Record<string, number> } {
  const db = open(path);
  try {
    const lines = db
      .prepare(
        "SELECT s.neighborhood AS neighborhood, SUM(json_extract(j.value, '$.quantity')) AS n FROM orders o " +
          "JOIN summaries s ON s.id = o.summary, json_each(s.lines) j " +
          "WHERE json_extract(j.value, '$.product') = ? AND o.created_at >= ? AND o.created_at < ? " +
          "GROUP BY s.neighborhood ORDER BY n DESC",
      )
      .all(product, start, end) as { neighborhood: string; n: number }[];
    return { total: lines.reduce((s, l) => s + l.n, 0), by_neighborhood: Object.fromEntries(lines.map((l) => [l.neighborhood, l.n])) };
  } finally {
    db.close();
  }
}
