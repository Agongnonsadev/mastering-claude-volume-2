// Read the log: costs, failure modes, latencies, conversations to pick up (chapter 8).
//
// The log is the trace of each call. Read properly, it answers Yao's questions: how much did the day
// cost, what fails and where does it come from, who is still waiting for an answer from Awa. It has the
// same format as that of the Python version: this dashboard reads one as well as the other.
//
// Chapter 19: the online Comptoir leaves a “message” event per message, with the cost of all its steps and
// its duration. The dashboard draws from it the cost per conversation, the latency as the customer sees
// it, the error rate, the security events of chapter 18 and alerts.

import { existsSync, readFileSync } from "node:fs";
import { config } from "./config.ts";
import { round } from "./rounding.ts";

/** A line of the log: a call, or an event. */
export type Line = Record<string, unknown> & { date: string };

// What leaves a customer without an answer: Awa must pick up the conversation by hand.
export const NO_ANSWER = new Set(["refusal", "over_budget", "counting_impossible", "invalid_key", "billing", "permission",
  "not_found", "invalid_request", "spend_limit", "tier_ceiling", "context_full"]);

// The events that are not call failures: they have their own section (chapters 18 and 19).
export const INFORMATIONAL = new Set(["message", "step", "purge", "guard", "limit", "suspicious_attempt", "whatsapp_send",
  "whatsapp_invalid_signature", "monitoring"]);

export function load(path: string = config.LOG): Line[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Line);
}

const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** The entries of a counter, from the most frequent to the least frequent, like Counter.most_common(). */
export function mostCommon<K>(count: Map<K, number>): [K, number][] {
  return [...count.entries()].sort((a, b) => b[1] - a[1]);
}

function counter<K>(keys: K[]): Map<K, number> {
  const count = new Map<K, number>();
  for (const key of keys) count.set(key, (count.get(key) ?? 0) + 1);
  return count;
}

/**
 * A call or a message in error, a refused send, or an event that is not information. A step in error
 * belongs to a message: it is counted with it, not twice.
 */
export function isAFailure(line: Line): boolean {
  const event = str(line.event);
  if (event === null || event === "message" || event === "whatsapp_send") return Boolean(line.error);
  return !INFORMATIONAL.has(event);
}

export interface Day {
  calls: number;
  dollars: number;
  input: number;
  output: number;
  failures: number;
}

export function byDay(lines: Line[]): Map<string, Day> {
  const days = new Map<string, Day>();
  for (const line of lines) {
    const key = line.date.slice(0, 10);
    const day = days.get(key) ?? { calls: 0, dollars: 0, input: 0, output: 0, failures: 0 };
    days.set(key, day);
    if ("event" in line) {
      day.failures += isAFailure(line) ? 1 : 0;
      continue;
    }
    day.calls += 1;
    day.dollars += num(line.cost_dollars);
    day.input += num(line.input_tokens) + num(line.cache_read_tokens);
    day.output += num(line.output_tokens);
    day.failures += line.error ? 1 : 0;
  }
  return new Map([...days.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export interface FailureMode {
  origin: string; // who must act: the network, the service, our code…
  code: string;
  count: number;
}

/** The failures by origin and by code, from the most frequent to the least frequent. */
export function failureModes(lines: Line[]): FailureMode[] {
  const count = counter(
    lines.filter(isAFailure).map((l) => `${str(l.origin) ?? "account"}\u0000${str(l.error) ?? str(l.event)}`),
  );
  return mostCommon(count).map(([key, n]) => {
    const [origin, code] = key.split("\u0000") as [string, string];
    return { origin, code, count: n };
  });
}

export function percentile(values: number[], rank: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, round((rank / 100) * (ordered.length - 1)))]!;
}

/** Median and 95th percentile of the duration of successful calls, in milliseconds. */
export function latencies(lines: Line[]): [number | null, number | null] {
  const durations = lines.filter((l) => "duration_ms" in l && !l.error && !("event" in l)).map((l) => num(l.duration_ms));
  return [percentile(durations, 50), percentile(durations, 95)];
}

export interface ToPickUp {
  date: string;
  conversation: string | null;
  reason: string;
}

/** The conversations left without an answer, which Awa must pick up herself. */
export function toPickUp(lines: Line[]): ToPickUp[] {
  return lines
    .filter((l) => NO_ANSWER.has(str(l.error) ?? str(l.event) ?? ""))
    .map((l) => ({
      date: l.date,
      conversation: str(l.customer) ?? str(l.conversation),
      reason: (str(l.error) ?? str(l.event))!,
    }));
}

// --- The online Comptoir (chapter 19) -------------------------------------------------------------

export const messages = (lines: Line[]): Line[] => lines.filter((l) => l.event === "message");

export interface Conversation {
  channel: string;
  messages: number;
  dollars: number;
}

/**
 * conversation -> channel, number of messages, total cost. All steps included, from the trace, and the
 * monitoring of chapter 18 when it is turned on (chapter 20).
 */
export function byConversation(lines: Line[]): Map<string, Conversation> {
  const conversations = new Map<string, Conversation>();
  for (const l of messages(lines)) {
    const key = str(l.conversation) ?? "?";
    const c = conversations.get(key) ?? { channel: "", messages: 0, dollars: 0 };
    conversations.set(key, c);
    c.channel = str(l.channel) ?? "";
    c.messages += 1;
    c.dollars += num(l.cost_dollars);
  }
  for (const l of lines) {
    const c = l.event === "monitoring" ? conversations.get(str(l.conversation) ?? "") : undefined;
    if (c) c.dollars += num(l.cost_dollars);
  }
  return conversations;
}

export function costPerConversation(lines: Line[]): { conversations: number; average: number | null; median: number | null } {
  const totals = [...byConversation(lines).values()].map((c) => c.dollars);
  if (!totals.length) return { conversations: 0, average: null, median: null };
  return { conversations: totals.length, average: totals.reduce((a, b) => a + b, 0) / totals.length, median: percentile(totals, 50) };
}

/** Median and 90th percentile of the duration of a message, all steps included: what the customer waits. */
export function messageLatencies(lines: Line[]): [number | null, number | null] {
  const durations = messages(lines).filter((l) => "duration_ms" in l && !l.error).map((l) => num(l.duration_ms));
  return [percentile(durations, 50), percentile(durations, 90)];
}

export function errorRate(lines: Line[]): number | null {
  const everything = messages(lines);
  return everything.length ? everything.filter((l) => l.error).length / everything.length : null;
}

const SECURITY = new Set(["guard", "limit", "suspicious_attempt", "over_budget", "purge", "whatsapp_invalid_signature"]);

/** The security and operations events, by name (chapters 18 and 19). */
export function events(lines: Line[]): Map<string, number> {
  return counter(
    lines
      .filter((l) => SECURITY.has(str(l.event) ?? "") || (l.event === "whatsapp_send" && l.error))
      .map((l) => String(l.event)),
  );
}

/** The conversations flagged at least `threshold` times by the monitoring: to be looked at closely. */
export function repeatOffenders(lines: Line[], threshold = 3): [string, number][] {
  const count = counter(lines.filter((l) => l.event === "suspicious_attempt").map((l) => String(l.conversation)));
  return mostCommon(count).filter(([, n]) => n >= threshold);
}

/** The date in UTC, to the second, in the log's format: 2026-10-22T08:15:00+00:00. */
const toTheSecond = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, "+00:00");

/** What must make Awa or Yao react, over the last 24 hours. */
export function alerts(lines: Line[], now = new Date()): string[] {
  const since = toTheSecond(new Date(now.getTime() - 24 * 3600 * 1000));
  const recent = lines.filter((l) => (l.date ?? "") >= since);
  const out: string[] = [];
  const spent = recent.filter((l) => l.event === "message" || l.event === "monitoring").reduce((s, l) => s + num(l.cost_dollars), 0);
  if (spent >= config.ALERT_THRESHOLD * config.DAILY_BUDGET) {
    out.push(`Spending over the last 24 hours: $${spent.toFixed(2)}, for a daily ceiling of $${config.DAILY_BUDGET.toFixed(2)}.`);
  }
  const rate = errorRate(recent);
  if (rate !== null && messages(recent).length >= 10 && rate > 0.05) out.push(`${Math.round(rate * 100)}% of the messages of the last 24 hours failed.`);
  if (recent.some((l) => l.event === "over_budget")) out.push("Customers received “The Comptoir can't answer right now” for lack of budget.");
  for (const [conversation, n] of repeatOffenders(recent)) out.push(`The conversation ${conversation.slice(0, 8)}… was flagged ${n} times by the monitoring.`);
  if (recent.some((l) => l.event === "whatsapp_not_configured")) {
    out.push("WhatsApp is not configured (the fingerprint salt is missing): the messages are waiting at Meta.");
  }
  if (recent.some((l) => (l.event === "whatsapp_send" || l.event === "whatsapp_processing") && l.error)) {
    out.push("WhatsApp messages were left without an answer: send refused or processing impossible.");
  }
  return out;
}

/** Like Python's html.escape: the log's content never becomes code of the page. */
export const escape = (t: string): string =>
  t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

/** A standalone page, with no library and no network call, to open in a browser. */
export function toHtml(lines: Line[]): string {
  const days = byDay(lines);
  const dearest = Math.max(0, ...[...days.values()].map((d) => d.dollars)) || 1;
  const rows = [...days.entries()]
    .map(([day, d]) =>
      `<tr><td>${day}</td><td>${d.calls}</td><td>$${d.dollars.toFixed(4)}</td><td>${d.failures}</td>` +
      `<td><div class='bar' style='width:${((100 * d.dollars) / dearest).toFixed(0)}%'></div></td></tr>`)
    .join("");
  const failures = failureModes(lines).map((m) => `<tr><td>${escape(m.origin)}</td><td>${escape(m.code)}</td><td>${m.count}</td></tr>`).join("");
  const pickUp = toPickUp(lines)
    .map((r) => `<tr><td>${escape(r.date)}</td><td>${escape(String(r.conversation))}</td><td>${escape(r.reason)}</td></tr>`)
    .join("");
  const [median, p95] = latencies(lines);
  const conv = costPerConversation(lines);
  const [medMsg, p90Msg] = messageLatencies(lines);
  const rate = errorRate(lines);
  const messageDuration = medMsg !== null ? `median ${medMsg.toFixed(0)} ms, 90th percentile ${p90Msg!.toFixed(0)} ms` : "no successful message";
  const online = conv.conversations
    ? `<p>${conv.conversations} conversation${conv.conversations > 1 ? "s" : ""}; average cost $${conv.average!.toFixed(4)}, median ` +
      `$${conv.median!.toFixed(4)}; a message: ${messageDuration}; errors: ${((rate ?? 0) * 100).toFixed(1)}%.</p>`
    : "<p>No online message so far.</p>";
  // The calls of the routed Comptoir have no duration in the log (it is on the steps): nothing to display.
  const callLatency = median !== null ? `median ${median.toFixed(0)} ms, 95th percentile ${p95!.toFixed(0)} ms` : "no call duration in the log";
  const alarms = alerts(lines).map((a) => `<li>${escape(a)}</li>`).join("") || "<li>None.</li>";
  const security = mostCommon(events(lines)).map(([name, n]) => `<tr><td>${escape(name)}</td><td>${n}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>The Comptoir: dashboard</title>
<style>body{font-family:system-ui,sans-serif;max-width:56rem;margin:0 auto;padding:1rem;color:#2b2118;background:#fdf8f3}
table{border-collapse:collapse;width:100%;margin-bottom:1.5rem}td,th{border-bottom:1px solid #ead9c8;padding:.35rem;text-align:left}
.bar{background:#d9772b;height:.8rem;border-radius:.2rem}</style></head><body>
<h1>The Comptoir: dashboard</h1>
<h2>Alerts (24 hours)</h2><ul>${alarms}</ul>
<h2>Online</h2>${online}
<h2>Security and operations</h2><table><tr><th>Event</th><th>Count</th></tr>${security}</table>
<p>Latency of successful calls: ${callLatency}.</p>
<h2>By day</h2><table><tr><th>Day</th><th>Calls</th><th>Cost</th><th>Failures</th><th></th></tr>${rows}</table>
<h2>Failure modes</h2><table><tr><th>Origin</th><th>Code</th><th>Count</th></tr>${failures}</table>
<h2>Conversations for Awa to pick up</h2><table><tr><th>Date</th><th>Conversation</th><th>Reason</th></tr>${pickUp}</table>
</body></html>`;
}
