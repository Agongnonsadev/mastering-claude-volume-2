// The Comptoir's budget: ceilings per customer, per day and per month, checked before each call
// (chapter 8).
//
// The principle is that of Studio Botlyx's daily ceiling: check before running, counting what is already
// in progress. Each call first reserves its maximum possible cost (known input, output at most
// max_tokens), then settles its real cost once finished. Ten calls started at the same time therefore
// cannot exceed the ceiling between the ten of them.
//
// Days and months are counted in universal time (UTC), like Anthropic's monthly ceiling, which restarts
// on the 1st at 00:00 UTC.

import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { openDatabase, randomId, transaction } from "./database.ts";

export interface Decision {
  accepted: boolean;
  reservation: string | null;
  reason: string | null; //  customer_quota, network_quota, daily_budget, monthly_budget
  alert: boolean; //         the alert threshold of the day or the month is crossed
}

export class Budget {
  readonly db: DatabaseSync;

  constructor(
    path = ":memory:",
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = openDatabase(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS expenses (
        id TEXT PRIMARY KEY, day TEXT NOT NULL, month TEXT NOT NULL,
        customer TEXT NOT NULL, dollars REAL NOT NULL, settled INTEGER NOT NULL, group_id TEXT)`,
    );
    // Chapter 18: the group_id column (the customer's network address), added to databases already created.
    const columns = this.db.prepare("PRAGMA table_info(expenses)").all().map((l) => l.name);
    if (!columns.includes("group_id")) this.db.exec("ALTER TABLE expenses ADD COLUMN group_id TEXT");
  }

  private now(): [day: string, month: string] {
    const instant = this.clock().toISOString();
    return [instant.slice(0, 10), instant.slice(0, 7)];
  }

  private sum(condition: string, ...values: string[]): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(dollars), 0) AS total FROM expenses WHERE ${condition}`).get(...values);
    return Number(row?.total ?? 0);
  }

  forDay(): number {
    return this.sum("day = ?", this.now()[0]);
  }

  forMonth(): number {
    return this.sum("month = ?", this.now()[1]);
  }

  forCustomer(customerId: string): number {
    return this.sum("day = ? AND customer = ?", this.now()[0], customerId);
  }

  forGroup(group: string): number {
    return this.sum("day = ? AND group_id = ?", this.now()[0], group);
  }

  /**
   * Reserves the maximum cost of a call, if it fits within the ceilings.
   *
   * group (chapter 18): what links several conversations, the network address on the web. A new
   * conversation at each message does not reset this counter to zero.
   */
  reserve(customerId: string, maximum: number, group: string | null = null): Decision {
    const [day, month] = this.now();
    // Check and reserve in the same transaction.
    const decision = transaction(this.db, (): Decision => {
      const ceilings: [string, number, number][] = [["customer_quota", this.forCustomer(customerId), config.CUSTOMER_DAILY_QUOTA]];
      if (group) ceilings.push(["network_quota", this.forGroup(group), config.NETWORK_DAILY_QUOTA]);
      ceilings.push(["daily_budget", this.forDay(), config.DAILY_BUDGET], ["monthly_budget", this.forMonth(), config.MONTHLY_BUDGET]);
      for (const [reason, spent, ceiling] of ceilings) {
        if (spent + maximum > ceiling) return { accepted: false, reservation: null, reason, alert: true };
      }
      const reservation = randomId();
      this.db
        .prepare("INSERT INTO expenses (id, day, month, customer, dollars, settled, group_id) VALUES (?, ?, ?, ?, ?, 0, ?)")
        .run(reservation, day, month, customerId, maximum, group);
      return { accepted: true, reservation, reason: null, alert: false };
    });
    return decision.accepted ? { ...decision, alert: this.onAlert() } : decision;
  }

  /** Replaces the reservation with the real cost of the call. */
  settle(reservation: string, dollars: number): void {
    this.db.prepare("UPDATE expenses SET dollars = ?, settled = 1 WHERE id = ?").run(dollars, reservation);
  }

  /**
   * Counts an expense already made, with no ceiling to check: the call has taken place (the monitoring
   * of chapter 19, which runs alongside the answer and reserves nothing beforehand).
   */
  add(customerId: string, dollars: number, group: string | null = null): void {
    const [day, month] = this.now();
    this.db
      .prepare("INSERT INTO expenses (id, day, month, customer, dollars, settled, group_id) VALUES (?, ?, ?, ?, ?, 1, ?)")
      .run(randomId(), day, month, customerId, dollars, group);
  }

  /** Cancels a reservation: the call cost nothing (refused by the API before any processing). */
  release(reservation: string): void {
    this.db.prepare("DELETE FROM expenses WHERE id = ?").run(reservation);
  }

  onAlert(): boolean {
    return this.forDay() >= config.ALERT_THRESHOLD * config.DAILY_BUDGET || this.forMonth() >= config.ALERT_THRESHOLD * config.MONTHLY_BUDGET;
  }
}
