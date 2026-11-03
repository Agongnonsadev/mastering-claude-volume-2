// The Comptoir's SQLite databases (conversations, budget), with the SQLite module built into Node: no
// dependency to compile. No flag needed since Node 22.13; Node 22 still announces it as experimental,
// with a warning at first use, which `npm test` and `npm run web` hide. Recent versions of Node also
// call it Database; DatabaseSync, its first name, works everywhere.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Opens a database, creating its folder; ":memory:" for an in-memory database (tests). */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  return new DatabaseSync(path);
}

/** All or nothing, like `with db:` in Python: committed if f succeeds, rolled back if it throws. */
export function transaction<T>(db: DatabaseSync, f: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = f();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** An identifier like uuid.uuid4().hex in Python: 32 hexadecimal characters. */
export const randomId = (): string => crypto.randomUUID().replaceAll("-", "");

/** A date like datetime.isoformat() in Python, in UTC: 2026-10-22T08:15:00.123000+00:00. */
export const isoformat = (date: Date): string => date.toISOString().replace(/Z$/, "000+00:00");
