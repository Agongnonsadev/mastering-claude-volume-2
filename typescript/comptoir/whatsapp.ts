// The Comptoir on WhatsApp (chapter 19): Meta's Cloud API, according to its documentation of October 22, 2026.
//
// - Webhook verification: Meta sends a GET with hub.mode=subscribe, hub.verify_token and hub.challenge;
//   hub.challenge is returned, status 200, if the token is the right one.
// - Signature: each notification carries X-Hub-Signature-256, “sha256=” followed by the HMAC-SHA256 of the
//   body, calculated with the app secret. A notification badly signed is refused.
// - Incoming messages: entry[].changes[].value.messages[], with from (the number), id (wamid…), type,
//   text.body; metadata.phone_number_id says which of the business's numbers to answer from. The statuses
//   (sent, read) are ignored.
// - Duplicates: Meta retries for 7 days a notification that did not get a 200, and can send it twice; each
//   message is handled only once (Directory.new).
// - Answer: POST https://graph.facebook.com/<version>/<phone_number_id>/messages, a text of 4,096 characters
//   at most, only in the 24-hour customer service window opened by the customer.
//
// A customer's number is personal data: it does not leave the directory (Directory), neither for the log,
// nor for the budget. Elsewhere, its fingerprint is written (pseudonym). The directory's tables are those of
// the Python version: the same database serves both.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isoformat, openDatabase, transaction } from "./database.ts";

export const GRAPH = "https://graph.facebook.com";
export const MAX_LENGTH = 4096;
// Anthropic's usage policy: tell the customer they are talking to an AI, at the start of each conversation.
// On the web, the page says it; on WhatsApp, it is the first message, written by the code.
export const AI_DISCLOSURE =
  "Hello, I'm the Comptoir, the automated assistant of Délices d'Awa: an artificial " +
  "intelligence, not a person. To talk to Awa, just ask.";
export const NOT_TEXT = "I can only read written messages for now: could you write your request to me?";

export function validSignature(body: Uint8Array, header: string | null | undefined, secret: string): boolean {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"));
  const received = Buffer.from(header.slice("sha256=".length));
  // Like hmac.compare_digest: a comparison time that says nothing of the position of a difference.
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * A stable fingerprint of the number: enough to count and limit, without writing the number. Without a salt,
 * it protects nothing (all the possible numbers can be tried): refused (chapter 20). The same as in Python.
 */
export function pseudonym(number: string, salt: string): string {
  if (!salt) throw new Error("The salt of the fingerprints (COMPTOIR_PSEUDONYM_SALT) is empty.");
  return "wa-" + createHmac("sha256", salt).update(number, "utf8").digest("hex").slice(0, 16);
}

export interface IncomingMessage {
  id: string; //               wamid…, unique: the key against duplicates
  number: string; //           the customer's WhatsApp number (from)
  businessNumber: string; //   metadata.phone_number_id: Awa's number that received the message
  type: string; //             text, image, audio…
  text: string | null;
  timestamp: number;
}

/** An unreadable notification (a timestamp that is not a number, for example): refused by the server. */
export class UnreadableNotification extends Error {}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/** Python's int(text): an integer written in digits, otherwise an error. */
function integer(value: unknown): number {
  if (!value) return 0;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) throw new UnreadableNotification(`unreadable timestamp: ${text}`);
  return Number(text);
}

export function incomingMessages(notification: unknown): IncomingMessage[] {
  const output: IncomingMessage[] = [];
  for (const entry of list(obj(notification).entry)) {
    for (const change of list(obj(entry).changes)) {
      if (obj(change).field !== "messages") continue;
      const value = obj(obj(change).value);
      const businessNumber = String(obj(value.metadata).phone_number_id ?? "");
      for (const raw of list(value.messages)) {
        const m = obj(raw);
        const text = obj(m.text).body;
        output.push({
          id: String(m.id ?? ""), number: String(m.from ?? ""), businessNumber, type: String(m.type ?? ""),
          text: typeof text === "string" ? text : null, timestamp: integer(m.timestamp),
        });
      }
    }
  }
  return output;
}

/**
 * A text too long for a single message, cut between two paragraphs when possible. The lengths are counted in
 * characters, as in Python (and not in UTF-16 units: an emoji counts for one).
 */
export function split(text: string, length = MAX_LENGTH): string[] {
  const parts: string[] = [];
  let rest = [...text];
  while (rest.length > length) {
    let cut = rest.slice(0, length).lastIndexOf("\n");
    cut = cut > Math.floor(length / 2) ? cut : length;
    parts.push(rest.slice(0, cut).join("").trimEnd());
    rest = [...rest.slice(cut).join("").trimStart()];
  }
  return rest.length ? [...parts, rest.join("")] : parts;
}

/** An error response from Meta, like httpx.HTTPStatusError: its status is recorded in the log. */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`Meta answered ${status}`);
  }
}

/** Sends the answers through the Graph API, with a system user's token (never in the code). */
export class Sender {
  constructor(
    private readonly token: string,
    private readonly version = "v26.0",
    private readonly http: typeof fetch = (input, options) => fetch(input, { ...options, signal: AbortSignal.timeout(30_000) }),
  ) {}

  /** Returns the IDs of the messages sent; raises HttpError if Meta refuses. */
  async send(businessNumber: string, number: string, text: string): Promise<string[]> {
    const ids: string[] = [];
    for (const part of split(text)) {
      const r = await this.http(`${GRAPH}/${this.version}/${businessNumber}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: number, type: "text", text: { body: part } }),
      });
      if (!r.ok) throw new HttpError(r.status);
      ids.push(...list(obj(await r.json()).messages).map((m) => obj(m).id as string));
    }
    return ids;
  }
}

const now = (): Date => new Date();

/**
 * For each WhatsApp customer: their fingerprint, their number (to answer them), their current conversation.
 * In the same database as the conversations, and purged with them: it is the only place of the number. Also
 * keeps the messages already handled, against Meta's duplicates.
 */
export class Directory {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = openDatabase(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_customers (
          pseudonym TEXT PRIMARY KEY, number TEXT NOT NULL, conversation TEXT NOT NULL, seen_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS whatsapp_already_seen (id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
    `);
  }

  /** True the first time this message is seen; false for a duplicate. */
  new(messageId: string): boolean {
    return transaction(this.db, () =>
      this.db.prepare("INSERT OR IGNORE INTO whatsapp_already_seen VALUES (?, ?)").run(messageId, isoformat(now())).changes === 1,
    );
  }

  conversation(pseudo: string): string | null {
    const row = this.db.prepare("SELECT conversation FROM whatsapp_customers WHERE pseudonym = ?").get(pseudo);
    return row ? String(row.conversation) : null;
  }

  link(pseudo: string, number: string, conversation: string): void {
    transaction(this.db, () => this.db.prepare("INSERT OR REPLACE INTO whatsapp_customers VALUES (?, ?, ?, ?)").run(pseudo, number, conversation, isoformat(now())));
  }

  /**
   * The number linked to a conversation that a customer asked to erase (chapter 21: the erasure command of
   * chapter 18 forgot the directory, where the number remained).
   */
  erase(conversation: string): number {
    return Number(transaction(this.db, () => this.db.prepare("DELETE FROM whatsapp_customers WHERE conversation = ?").run(conversation).changes));
  }

  /** Forgets the customers without a message for `days` days, and the duplicates older than 8 days (Meta retries only for 7 days). */
  purge(days: number, instant: Date = now()): number {
    const before = (d: number): string => isoformat(new Date(instant.getTime() - d * 86_400_000));
    return transaction(this.db, () => {
      const customers = this.db.prepare("DELETE FROM whatsapp_customers WHERE seen_at < ?").run(before(days)).changes;
      this.db.prepare("DELETE FROM whatsapp_already_seen WHERE received_at < ?").run(before(8));
      return Number(customers);
    });
  }
}
