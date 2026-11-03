// Awa's shop as the code sees it: stock, summaries, orders, requests (chapter 9).
//
// This is where, and not in the model, the rules that commit money live: the prices, the delivery fee,
// the stock, and above all the creation of an order. Claude prepares a summary; only the customer, with a
// confirmation code that the code checks, turns it into an order. And an order is created only once.

import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isoformat, openDatabase, randomId, transaction } from "./database.ts";
import { nameProblem, neighborhoodProblem } from "./guard.ts";
import { PYTHON } from "./launch.ts";
import { type Data, loadData } from "./prompt.ts";

export const DELIVERY_FEE = 500; //            FCFA, below the threshold (Awa's terms)
export const FREE_DELIVERY_THRESHOLD = 5; //   bottles
export const MAXIMUM_WITHOUT_QUOTE = 50; //    bottles: beyond that, Awa makes a quote
export const SUMMARY_VALIDITY_MS = 2 * 3600 * 1000;
const COTONOU_OFFSET = 1; // Benin is at UTC+1, with no daylight saving time
const DAY_MS = 24 * 3600 * 1000;

/** A request the shop refuses, with a message that says what to do. */
export class ShopRefusal extends Error {}

/** “Larissa Noudéhou” -> “Larissa N.”: enough for a past order, without the full name. */
export function initial(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return parts.length < 2 ? name : `${parts[0]} ${parts.at(-1)![0]}.`;
}

export interface RequestedLine {
  product: string;
  quantity: number;
}

interface Line {
  product: string;
  quantity: number;
  unit_price: number;
}

export interface Summary {
  summary: string;
  lines: (Line & { amount: number })[];
  delivery_fee: number;
  total_fcfa: number;
  planned_delivery: string;
  customer_name: string;
  neighborhood: string;
  confirmation_code: string;
  to_tell_the_customer: string;
}

export interface Options {
  data?: Data;
  stock?: Record<string, number>;
  clock?: () => Date;
  /** An integer drawn at random between 0 and n − 1: the system's, except in the tests. */
  rng?: (n: number) => number;
}

export class Shop {
  readonly db: DatabaseSync;
  readonly catalog: Map<string, Data["products"][number]>;
  private readonly clock: () => Date;
  private readonly rng: (n: number) => number;

  constructor(path = ":memory:", { data, stock, clock, rng }: Options = {}) {
    this.db = openDatabase(path);
    this.clock = clock ?? (() => new Date());
    this.rng = rng ?? ((n) => randomInt(n));
    this.catalog = new Map((data ?? loadData()).products.map((p) => [p.name, p]));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stock (product TEXT PRIMARY KEY, quantity INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS summaries (
          id TEXT PRIMARY KEY, conversation TEXT NOT NULL, code TEXT NOT NULL, lines TEXT NOT NULL,
          customer_name TEXT NOT NULL, neighborhood TEXT NOT NULL, delivery_fee INTEGER NOT NULL,
          total INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY, summary TEXT NOT NULL UNIQUE, conversation TEXT NOT NULL,
          total INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (
          id TEXT PRIMARY KEY, conversation TEXT NOT NULL, reason TEXT NOT NULL, summary TEXT NOT NULL,
          created_at TEXT NOT NULL);
    `);
    let initialStock = stock;
    if (initialStock === undefined && !this.db.prepare("SELECT 1 FROM stock").get()) {
      initialStock = JSON.parse(readFileSync(join(PYTHON, "comptoir", "data", "initial_stock.json"), "utf8")).stock;
    }
    if (initialStock !== undefined) {
      const insert = this.db.prepare("INSERT OR REPLACE INTO stock VALUES (?, ?)");
      transaction(this.db, () => Object.entries(initialStock!).forEach(([product, quantity]) => insert.run(product, quantity)));
    }
  }

  private now(): Date {
    return this.clock();
  }

  // --- Read -------------------------------------------------------------------------------

  /** The quantity in stock, or null if the product is not in the catalog. */
  available(product: string): number | null {
    if (!this.catalog.has(product)) return null;
    const row = this.db.prepare("SELECT quantity FROM stock WHERE product = ?").get(product);
    return row ? Number(row.quantity) : 0;
  }

  private isABottle(product: string): boolean {
    // The juices come in 500 ml bottles; a bottle of syrup does not count toward free delivery.
    return this.catalog.get(product)!.format.endsWith("ml bottle");
  }

  /** The same day for an order placed before 12 p.m. (Cotonou time), otherwise the next day. */
  plannedDelivery(instant: Date): string {
    return (instant.getUTCHours() + COTONOU_OFFSET) % 24 < 12 ? "today" : "tomorrow";
  }

  // --- Prepare a summary (what Claude can do) --------------------------------

  prepare(conversation: string, lines: RequestedLine[], customerName: string, neighborhood: string): Summary {
    if (!lines.length) throw new ShopRefusal("The order is empty: ask the customer what they would like.");
    // Chapter 18: the name and the neighborhood end up in Awa's Claude application. Short data, nothing
    // else: the rest of the customer's message has nothing to do in the shop.
    for (const problem of [nameProblem(customerName), neighborhoodProblem(neighborhood)]) {
      if (problem) {
        throw new ShopRefusal(
          `Summary refused: ${problem}. Give only the name given for delivery and the name ` +
            "of the neighborhood, without an address, without comment or instruction; ask the customer for them if needed.",
        );
      }
    }
    const name = customerName.trim();
    const place = neighborhood.trim();
    const kept: Line[] = [];
    for (const { product, quantity } of lines) {
      const entry = this.catalog.get(product);
      if (!entry) {
        throw new ShopRefusal(
          `Product “${product}” missing from the catalog. Available products: ${[...this.catalog.keys()].join(", ")}. ` +
            "Offer the customer to choose among them.",
        );
      }
      if (quantity < 1) throw new ShopRefusal(`Quantity ${quantity} invalid for ${product}: at least 1 is needed.`);
      const stock = this.available(product)!;
      if (quantity > stock) {
        throw new ShopRefusal(
          `Insufficient stock: ${stock} available for ${product}, ${quantity} requested. ` +
            "Offer a possible quantity or another product; prepare nothing without the customer's consent.",
        );
      }
      kept.push({ product, quantity, unit_price: entry.price_fcfa });
    }

    const bottles = kept.filter((l) => this.isABottle(l.product)).reduce((s, l) => s + l.quantity, 0);
    if (bottles > MAXIMUM_WITHOUT_QUOTE) {
      throw new ShopRefusal(
        `${bottles} bottles: beyond ${MAXIMUM_WITHOUT_QUOTE}, the price is on quote. Use pass_to_awa with the reason quote.`,
      );
    }
    const fee = bottles >= FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_FEE;
    const total = kept.reduce((s, l) => s + l.quantity * l.unit_price, 0) + fee;
    const now = this.now();
    const code = String(this.rng(10_000)).padStart(4, "0");
    const id = randomId();
    transaction(this.db, () => {
      // A new summary cancels the previous one of the same conversation: the customer changed their mind,
      // and the old code must no longer create anything.
      this.db.prepare("UPDATE summaries SET status = 'replaced' WHERE conversation = ? AND status = 'pending'").run(conversation);
      this.db
        .prepare("INSERT INTO summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
        .run(id, conversation, code, JSON.stringify(kept), name, place, fee, total, isoformat(now));
    });
    return {
      summary: id.slice(0, 8),
      lines: kept.map((l) => ({ ...l, amount: l.quantity * l.unit_price })),
      delivery_fee: fee,
      total_fcfa: total,
      planned_delivery: this.plannedDelivery(now),
      customer_name: name,
      neighborhood: place,
      confirmation_code: code,
      to_tell_the_customer: `To confirm, the customer replies exactly: YES ${code}`,
    };
  }

  // --- Confirm (what only the customer can do, with their code) ---------------------------

  /** Creates the order, only once. Calling again with the same code returns the same order. */
  confirm(conversation: string, code: string): { order: string; total_fcfa: number; already_recorded: boolean } {
    return transaction(this.db, () => {
      const summary = this.db
        .prepare("SELECT id, lines, total, status, created_at FROM summaries WHERE conversation = ? AND code = ? ORDER BY created_at DESC LIMIT 1")
        .get(conversation, code);
      if (!summary) throw new ShopRefusal("This code matches no summary of this conversation.");
      const total = Number(summary.total);
      if (summary.status === "confirmed") {
        const order = this.db.prepare("SELECT id FROM orders WHERE summary = ?").get(summary.id as string);
        return { order: String(order!.id), total_fcfa: total, already_recorded: true };
      }
      if (summary.status === "replaced") throw new ShopRefusal("This summary has been replaced by a more recent one: use the last code received.");
      if (this.now().getTime() - new Date(String(summary.created_at)).getTime() > SUMMARY_VALIDITY_MS) {
        throw new ShopRefusal("This summary has expired: ask for a new one.");
      }
      const lines = JSON.parse(String(summary.lines)) as Line[];
      // The stock may have changed since the summary: it is checked again at the moment of creating.
      for (const l of lines) {
        if (l.quantity > (this.available(l.product) ?? 0)) throw new ShopRefusal(`The stock of ${l.product} has changed: ask for a new summary.`);
      }
      const remove = this.db.prepare("UPDATE stock SET quantity = quantity - ? WHERE product = ?");
      for (const l of lines) remove.run(l.quantity, l.product);
      const rank = Number(this.db.prepare("SELECT COUNT(*) + 1 AS rank FROM orders").get()!.rank);
      const number = `C-${String(rank).padStart(4, "0")}`;
      // The UNIQUE constraint on the summary forbids, as a last resort, any double order.
      this.db.prepare("INSERT INTO orders VALUES (?, ?, ?, ?, ?)").run(number, summary.id as string, conversation, total, isoformat(this.now()));
      this.db.prepare("UPDATE summaries SET status = 'confirmed' WHERE id = ?").run(summary.id as string);
      return { order: number, total_fcfa: total, already_recorded: false };
    });
  }

  // --- Pass on to Awa -----------------------------------------------------------------

  passOn(conversation: string, reason: string, summary: string): { request: string; passed_on: true } {
    const id = `D-${randomId().slice(0, 6)}`;
    this.db.prepare("INSERT INTO requests VALUES (?, ?, ?, ?, ?)").run(id, conversation, reason, summary, isoformat(this.now()));
    return { request: id, passed_on: true };
  }

  // --- Keep only what is necessary (chapter 18) -----------------------------------------

  /** Applies Awa's retention periods. Returns what was erased or reduced. */
  purge(requestDays: number, nameDays: number, summaryDays: number, now = this.now()) {
    const before = (days: number) => isoformat(new Date(now.getTime() - days * DAY_MS));
    return transaction(this.db, () => {
      const requests = Number(this.db.prepare("DELETE FROM requests WHERE created_at < ?").run(before(requestDays)).changes);
      const summaries = Number(this.db.prepare("DELETE FROM summaries WHERE status != 'confirmed' AND created_at < ?").run(before(summaryDays)).changes);
      let names = 0;
      const old = this.db.prepare("SELECT id, customer_name FROM summaries WHERE status = 'confirmed' AND created_at < ?").all(before(nameDays));
      for (const { id, customer_name } of old) {
        const name = String(customer_name);
        if (initial(name) !== name) {
          this.db.prepare("UPDATE summaries SET customer_name = ? WHERE id = ?").run(initial(name), id as string);
          names++;
        }
      }
      return { requests_erased: requests, summaries_erased: summaries, names_reduced: names };
    });
  }

  /**
   * At a customer's request: everything that comes from their conversation, except what the accounts
   * require. Their orders stay (products, total, date, neighborhood), under their first name and initial only.
   */
  erase(conversation: string): { requests_erased: number; summaries_erased: number } {
    return transaction(this.db, () => {
      const requests = Number(this.db.prepare("DELETE FROM requests WHERE conversation = ?").run(conversation).changes);
      const summaries = Number(this.db.prepare("DELETE FROM summaries WHERE conversation = ? AND status != 'confirmed'").run(conversation).changes);
      for (const { id, customer_name } of this.db.prepare("SELECT id, customer_name FROM summaries WHERE conversation = ?").all(conversation)) {
        this.db.prepare("UPDATE summaries SET customer_name = ? WHERE id = ?").run(initial(String(customer_name)), id as string);
      }
      return { requests_erased: requests, summaries_erased: summaries };
    });
  }

  // --- For the tests and the dashboard -----------------------------------------------

  orders(): { id: string; summary: string; conversation: string; total: number }[] {
    return this.db.prepare("SELECT id, summary, conversation, total FROM orders").all() as never;
  }

  requests(): { id: string; conversation: string; reason: string; summary: string }[] {
    return this.db.prepare("SELECT id, conversation, reason, summary FROM requests").all() as never;
  }

  summaries(conversation: string): { code: string; status: string; total: number; lines: string }[] {
    return this.db.prepare("SELECT code, status, total, lines FROM summaries WHERE conversation = ? ORDER BY created_at").all(conversation) as never;
  }
}
