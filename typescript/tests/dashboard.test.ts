// The dashboard reads the log: costs per day, failure modes, latencies, conversations to pick up
// (python/tests/test_dashboard.py); cost per conversation, alerts and repeat offenders (the dashboard's
// tests in python/tests/test_ch19.py); and the same results as the Python version, on the same log.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  type Line, alerts, byConversation, byDay, costPerConversation, errorRate, events, failureModes, latencies, load,
  messageLatencies, percentile, toHtml, toPickUp,
} from "../comptoir/dashboard.ts";
import { PYTHON } from "../comptoir/launch.ts";
import { logEvent } from "../comptoir/log.ts";
import { approx, restoreConfig, setConfig, temporaryLog } from "./fake_clients.ts";

const LOG: Line[] = [
  { date: "2026-10-20T08:00:00+00:00", request: "r1", cost_dollars: 0.004, input_tokens: 1000, output_tokens: 100, stop_reason: "end_turn", duration_ms: 900, customer: "c1" },
  { date: "2026-10-20T08:05:00+00:00", request: "r2", cost_dollars: 0.006, input_tokens: 1500, output_tokens: 150, stop_reason: "end_turn", duration_ms: 1500, customer: "c1" },
  { date: "2026-10-20T09:00:00+00:00", request: null, cost_dollars: null, interrupted: true, error: "overloaded", origin: "service", duration_ms: 30000, customer: "c2" },
  { date: "2026-10-20T10:00:00+00:00", request: "r4", cost_dollars: 0.001, stop_reason: "refusal", error: "refusal", origin: "model", customer: "c3" },
  { date: "2026-10-21T07:00:00+00:00", event: "over_budget", reason: "customer_quota", customer: "c4" },
];

let log: string;
beforeEach(() => {
  log = temporaryLog();
});
afterEach(restoreConfig);

test("the costs per day", () => {
  const days = byDay(LOG);
  assert.equal(days.get("2026-10-20")!.calls, 4);
  approx(days.get("2026-10-20")!.dollars, 0.011);
  assert.equal(days.get("2026-10-20")!.failures, 2);
  assert.equal(days.get("2026-10-21")!.failures, 1);
});

test("the failure modes, by origin", () => {
  assert.deepEqual(new Set(failureModes(LOG).map((m) => `${m.origin}/${m.code}/${m.count}`)), new Set(["service/overloaded/1", "model/refusal/1", "account/over_budget/1"]));
});

test("the latencies ignore the failures", () => {
  assert.deepEqual(latencies(LOG), [900, 1500]); // the overloaded call (30 s) is not counted
  assert.equal(percentile([], 50), null);
});

test("the conversations to pick up", () => {
  // An overload is retried; a refusal or an exhausted budget leave the customer without an answer.
  assert.deepEqual(toPickUp(LOG).map((r) => r.conversation), ["c3", "c4"]);
});

test("the HTML page escapes the log's content", () => {
  const path = join(mkdtempSync(join(tmpdir(), "comptoir-")), "calls.jsonl");
  const trap = { date: "2026-10-20T11:00:00+00:00", event: "over_budget", customer: "<script>x</script>" };
  writeFileSync(path, [...LOG, trap].map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  const page = toHtml(load(path));
  assert.ok(!page.includes("<script>x</script>"));
  assert.ok(page.includes("&lt;script&gt;"));
});

// --- The online Comptoir (chapter 19) -------------------------------------------------------------

test("the cost per conversation, and the steps are not failures", () => {
  for (const [conversation, cost] of [["c1", 0.001], ["c1", 0.002], ["c2", 0.004]] as const) {
    logEvent("message", { channel: "web", conversation, category: "order", cost_dollars: cost, duration_ms: 5000 });
  }
  logEvent("step", { trace: "t", step: "routing" });
  const lines = load(log);
  approx(byConversation(lines).get("c1")!.dollars, 0.003);
  approx(costPerConversation(lines).average!, 0.0035);
  assert.equal(byDay(lines).get(lines[0]!.date.slice(0, 10))!.failures, 0);
  const page = toHtml(lines);
  assert.ok(page.includes("2 conversations; average cost $0.0035"));
  assert.ok(page.includes("no call duration")); // and not “0 ms”
});

test("the alerts and the repeat offenders", () => {
  setConfig({ DAILY_BUDGET: 0.01 });
  logEvent("message", { channel: "web", conversation: "c1", cost_dollars: 0.009, duration_ms: 4000 });
  for (let i = 0; i < 3; i++) logEvent("suspicious_attempt", { conversation: "c-suspicious-123", channel: "web" });
  const list = alerts(load(log));
  assert.ok(list.some((a) => a.includes("Spending")));
  assert.ok(list.some((a) => a.includes("flagged 3 times")));
});

test("the day's spending also counts the monitoring", () => {
  setConfig({ DAILY_BUDGET: 0.01 });
  logEvent("message", { channel: "web", conversation: "c1", cost_dollars: 0.007, duration_ms: 4000 });
  assert.ok(!alerts(load(log)).some((a) => a.includes("Spending")));
  logEvent("monitoring", { channel: "web", conversation: "c1", cost_dollars: 0.002 });
  assert.ok(alerts(load(log)).some((a) => a.includes("Spending")));
});

test("the security events and the error rate", () => {
  logEvent("message", { channel: "web", conversation: "c1", cost_dollars: 0.001, duration_ms: 3000 });
  logEvent("message", { channel: "whatsapp", conversation: "c2", error: "invalid_key", origin: "account" });
  logEvent("whatsapp_invalid_signature", {});
  logEvent("whatsapp_invalid_signature", {});
  const lines = load(log);
  assert.equal(events(lines).get("whatsapp_invalid_signature"), 2);
  assert.equal(errorRate(lines), 0.5);
  assert.deepEqual(messageLatencies(lines), [3000, 3000]);
  assert.equal(failureModes(lines).find((m) => m.code === "invalid_key")?.count, 1);
});

// --- The same results as the Python version --------------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

test("on the same log, the same figures as the Python version's dashboard", { skip: PYTHON_VENV ? false : "Python environment missing" }, () => {
  const lines: Line[] = [
    ...LOG,
    { date: "2026-10-21T08:00:00+00:00", event: "message", channel: "web", conversation: "c5", cost_dollars: 0.002, duration_ms: 2500 },
    { date: "2026-10-21T08:01:00+00:00", event: "message", channel: "web", conversation: "c5", cost_dollars: 0.003, duration_ms: 3500 },
    { date: "2026-10-21T08:02:00+00:00", event: "message", channel: "whatsapp", conversation: "c6", error: "overloaded", origin: "service" },
    { date: "2026-10-21T08:03:00+00:00", event: "monitoring", conversation: "c5", cost_dollars: 0.0001 },
    { date: "2026-10-21T08:04:00+00:00", event: "limit", reason: "messages_per_minute", address: "1.2.3.4" },
    { date: "2026-10-21T08:05:00+00:00", event: "step", trace: "t", step: "routing", error: "overloaded" },
  ];
  const path = join(mkdtempSync(join(tmpdir(), "comptoir-")), "calls.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  const script = `
import json, sys
from datetime import datetime, timezone
from comptoir import dashboard
l = dashboard.load(sys.argv[1])
print(json.dumps({
  "days": dashboard.by_day(l),
  "modes": sorted([o, c, n] for (o, c), n in dashboard.failure_modes(l).items()),
  "latencies": dashboard.latencies(l),
  "pick_up": dashboard.to_pick_up(l),
  "conversations": dashboard.cost_per_conversation(l),
  "messages": dashboard.message_latencies(l),
  "rate": dashboard.error_rate(l),
  "events": dict(dashboard.events(l)),
  "alerts": dashboard.alerts(l, datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)),
}))`;
  const python = JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script, path], { cwd: PYTHON, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }));
  const l = load(path);
  const days = Object.fromEntries([...byDay(l)].map(([d, v]) => [d, { ...v, dollars: Math.round(v.dollars * 1e9) / 1e9 }]));
  for (const v of Object.values(python.days) as { dollars: number }[]) v.dollars = Math.round(v.dollars * 1e9) / 1e9;
  assert.deepEqual(days, python.days);
  assert.deepEqual(failureModes(l).map((m) => [m.origin, m.code, m.count]).sort(), python.modes);
  assert.deepEqual(latencies(l), python.latencies);
  assert.deepEqual(toPickUp(l), python.pick_up);
  const conversations = costPerConversation(l);
  assert.equal(conversations.conversations, python.conversations.conversations);
  approx(conversations.average!, python.conversations.average);
  assert.deepEqual(messageLatencies(l), python.messages);
  approx(errorRate(l)!, python.rate);
  assert.deepEqual(Object.fromEntries(events(l)), python.events);
  assert.deepEqual(alerts(l, new Date("2026-10-21T12:00:00Z")), python.alerts);
});
