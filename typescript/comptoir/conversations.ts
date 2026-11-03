// The Comptoir's conversations, kept by the application (chapter 6).
//
// The API keeps nothing: this is where the history lives. It is append-only: messages are added, a past
// message of an open conversation is never modified or deleted. The blocks returned by Claude, thinking
// included, are kept as they are.

import type Anthropic from "@anthropic-ai/sdk";
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { isoformat, openDatabase, randomId, transaction } from "./database.ts";

/** A message of the history, as it is sent back to the API. */
export type HistoryMessage = Anthropic.MessageParam;
export type ClosingReason = "new_prompt" | "expired" | "too_long";

/**
 * The content of a message, in a form that is stored as JSON and sent back to the API: without the empty
 * fields (citations: null…) that the answer carries, and that the API refuses when they are sent back to
 * it. A tool's arguments (input) are data: they stay as they are.
 */
export function toBlocks(content: unknown): unknown {
  if (Array.isArray(content)) return content.map(toBlocks);
  if (content !== null && typeof content === "object") {
    return Object.fromEntries(
      Object.entries(content)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, k === "input" ? v : toBlocks(v)]),
    );
  }
  return content;
}

export class Conversations {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = openDatabase(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_activity TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        prompt TEXT);
      CREATE TABLE IF NOT EXISTS messages (
        conversation TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (conversation, position));
      PRAGMA foreign_keys = ON;
    `);
  }

  /** prompt: the ID of the system prompt (version and fingerprint) that opens the conversation. */
  create(prompt: string | null = null): string {
    const id = randomId();
    const date = isoformat(new Date());
    this.db.prepare("INSERT INTO conversations VALUES (?, ?, ?, 0, ?)").run(id, date, date, prompt);
    return id;
  }

  exists(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id) !== undefined;
  }

  history(id: string): HistoryMessage[] {
    return this.db
      .prepare("SELECT role, content FROM messages WHERE conversation = ? ORDER BY position")
      .all(id)
      .map((l) => ({ role: l.role, content: JSON.parse(String(l.content)) }) as HistoryMessage);
  }

  /**
   * Adds a complete turn (the customer's message, Claude's answer) in a single transaction.
   *
   * A question is never recorded without its answer: if the call fails, nothing is written, and the
   * history stays as Claude last saw it.
   * tokens: the size of the context after this turn (input, cache included, plus the output).
   */
  addTurn(id: string, messages: { role: string; content: unknown }[], tokens: number): void {
    transaction(this.db, () => {
      const row = this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM messages WHERE conversation = ?").get(id);
      const position = Number(row?.position ?? 0);
      const insert = this.db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)");
      messages.forEach((message, offset) => {
        insert.run(id, position + offset, message.role, JSON.stringify(toBlocks(message.content)));
      });
      this.db
        .prepare("UPDATE conversations SET last_activity = ?, tokens = ? WHERE id = ?")
        .run(isoformat(new Date()), tokens, id);
    });
  }

  /**
   * “new_prompt”, “expired”, “too_long”, or null if the conversation can continue.
   *
   * A modified system prompt invalidates the thinking blocks already in the history: the next request
   * would be refused (400 error). The conversation is therefore closed when today's prompt is no longer
   * the one that opened it.
   */
  closingReason(id: string, prompt: string | null = null, now = new Date()): ClosingReason | null {
    const row = this.db.prepare("SELECT last_activity, tokens, prompt FROM conversations WHERE id = ?").get(id);
    if (!row) throw new Error(`Unknown conversation: ${id}`);
    if (prompt !== null && prompt !== row.prompt) return "new_prompt";
    const elapsed = now.getTime() - new Date(String(row.last_activity)).getTime();
    if (elapsed > config.EXPIRY_H * 3600 * 1000) return "expired";
    if (Number(row.tokens) > config.MAX_CONTEXT) return "too_long";
    return null;
  }

  /** At the customer's request (chapter 18): the conversation and all its messages, right away. */
  erase(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id).changes) === 1;
  }

  /** Deletes the conversations with no activity for RETENTION_DAYS days. Returns their number. */
  purge(now = new Date()): number {
    const limit = new Date(now.getTime() - config.RETENTION_DAYS * 24 * 3600 * 1000);
    return Number(this.db.prepare("DELETE FROM conversations WHERE last_activity < ?").run(isoformat(limit)).changes);
  }
}
