// Chapter 21: the watch over the models and the SDK, the estimate of a project, the erasure of a number. No
// call to the API. The tests of python/tests/test_ch21.py, then the same texts as the Python version.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Shop } from "../comptoir/shop.ts";
import { Conversations } from "../comptoir/conversations.ts";
import { PYTHON, ROOT } from "../comptoir/launch.ts";
import * as whatsapp from "../comptoir/whatsapp.ts";
import * as data from "../ch18/data.ts";
import * as ep from "../ch21/estimate_project.ts";
import * as watch from "../ch21/watch.ts";
import { approx, restoreConfig, setConfig, temporaryLog } from "./fake_clients.ts";

beforeEach(() => temporaryLog());
afterEach(restoreConfig);

const NOW = new Date(Date.UTC(2026, 9, 22));
// Three lines of the “Model status” table of the deprecations page, as read on October 22, 2026.
const PAGE = `| API model name             | Current state | Deprecated         | Tentative retirement date          |
| :------------------------- | :------------ | :----------------- | :--------------------------------- |
| claude-sonnet-5-5          | Active        | N/A                | Not sooner than September 28, 2027 |
| claude-sonnet-4-5-20250929 | Deprecated    | September 30, 2026 | November 30, 2026                  |
| claude-haiku-4-5-20251001  | Active        | N/A                | Not sooner than October 15, 2026   |
`;

const model = (id: string, lifecycle = "active", retires_at: string | null = null): watch.SeenModel => ({ id, lifecycle, retires_at });

test("the deprecations page reads as states and dates", () => {
  const states = watch.publishedStates(PAGE);
  assert.equal(states["claude-sonnet-4-5-20250929"]!.state, "Deprecated");
  assert.deepEqual(states["claude-sonnet-4-5-20250929"]!.retirement, new Date(Date.UTC(2026, 10, 30)));
  assert.ok(states["claude-sonnet-5-5"]!.notBefore && !states["claude-sonnet-4-5-20250929"]!.notBefore);
});

test("a model deprecated on the page alerts, even if the API says active", () => {
  // Found on October 22, 2026: the Models API said “active” for Claude Sonnet 4.5.
  const catalog = { "claude-sonnet-4-5-20250929": model("claude-sonnet-4-5-20250929") };
  const report = watch.examineModels(catalog, watch.publishedStates(PAGE), { MODEL: "claude-sonnet-4-5-20250929" }, 120, NOW);
  assert.ok(report.alerts.some((a) => a.includes("Deprecated") && a.includes("2026-11-30")));
  assert.ok(report.alerts.some((a) => a.includes("the page is authoritative")));
});

test("an active model gives its floor date, and no alias escapes", () => {
  const catalog = { "claude-sonnet-5-5": model("claude-sonnet-5-5"), "claude-haiku-4-5-20251001": model("claude-haiku-4-5-20251001") };
  const report = watch.examineModels(catalog, watch.publishedStates(PAGE), { MODEL: "claude-sonnet-5-5", ROUTER_MODEL: "claude-haiku-4-5" }, 120, NOW);
  assert.deepEqual(report.alerts, []);
  assert.ok(report.infos.some((i) => i.includes("not before 2027-09-28")));
  assert.ok(report.infos.some((i) => i.startsWith("claude-haiku-4-5 "))); // the alias finds the dated version
});

test("a nearby retirement, or a missing model, alerts", () => {
  const near = model("claude-x-1", "active", "2026-12-01T00:00:00Z");
  const report = watch.examineModels({ "claude-x-1": near }, {}, { A: "claude-x-1", B: "claude-gone-1" }, 120, NOW);
  assert.ok(report.alerts.some((a) => a.includes("retirement on 2026-12-01, in 40 days")));
  assert.ok(report.alerts.some((a) => a.includes("claude-gone-1") && a.includes("missing")));
  assert.deepEqual(watch.examineModels({}, null, {}, 120, NOW).alerts, ["Deprecations page unreachable: only the Models API was read"]);
});

test("one more major version of the SDK alerts", () => {
  assert.ok(watch.examineSdk("0.137.0", "1.1.0", "2023-06-01").alerts.length);
  const minor = watch.examineSdk("1.1.0", "1.3.0", "2026-10-21");
  assert.ok(!minor.alerts.length && minor.infos[0]!.includes("same major version"));
  assert.ok(watch.examineSdk("1.1.0", "1.1.0", "2026-10-21").infos[0]!.includes("up to date"));
  assert.ok(watch.examineSdk("1.1.0", null, "2026-10-21").alerts.length);
});

test("the API version is read without any request leaving", async () => {
  // SDK 1.0.0 moved to the API 2026-10-21 (its changelog); no network here.
  assert.equal(await watch.apiVersionSent(), "2026-10-21");
  assert.equal(watch.installedVersion().split(".")[0], "1");
});

test("the models written in the repository are listed", () => {
  const folder = mkdtempSync(join(tmpdir(), "ch21-"));
  mkdirSync(join(folder, "comptoir"));
  writeFileSync(join(folder, "comptoir", "call.ts"), 'export const MODEL = "claude-sonnet-4-5-20250929";\n', "utf8");
  mkdirSync(join(folder, "tests"));
  writeFileSync(join(folder, "tests", "x.test.ts"), '"claude-haiku-4-5"\n', "utf8"); // the tests do not count
  mkdirSync(join(folder, "node_modules", "package"), { recursive: true });
  writeFileSync(join(folder, "node_modules", "package", "index.ts"), '"claude-opus-4-1"\n', "utf8"); // nor the dependencies
  assert.deepEqual(watch.modelsOfTheRepository(folder), { "claude-sonnet-4-5-20250929": new Set(["comptoir/call.ts"]) });
});

// --- Erasure on request, with WhatsApp ---------------------------------------------------------

test("erasing a conversation also erases the WhatsApp number", () => {
  // Found while writing the operations procedure: the number remained in the directory of chapter 19.
  setConfig({ PSEUDONYM_SALT: "test-salt" });
  const shop = new Shop();
  const conversations = new Conversations();
  const directory = new whatsapp.Directory();
  const conversation = conversations.create("system-v5");
  directory.link(whatsapp.pseudonym("22997000000", "test-salt"), "22997000000", conversation);
  const result = data.eraseNumber(shop, conversations, directory, "22997000000");
  assert.ok(result.conversation_found && result.conversation_erased && result.number_erased);
  assert.equal(directory.conversation(whatsapp.pseudonym("22997000000", "test-salt")), null);
  assert.deepEqual(data.eraseNumber(shop, conversations, directory, "22997000000"), { conversation_found: false });
});

test("the daily purge also forgets old numbers", () => {
  assert.equal(data.purge(new Shop(), new Conversations(), new whatsapp.Directory()).whatsapp_customers_forgotten, 0);
});

// --- The estimate of a project, and the watch job ---------------------------------------------------

test("the estimate starts from the measured prices, and counts the free messages", () => {
  const e = ep.estimate(1500, { whatsapp: true, hosting: 7.0 });
  approx(e.claude, 1500 * 0.00075);
  approx(e.claudeWithMargin, 1500 * 0.00075 * 1.5);
  approx(e.whatsapp, 500 * 0.004); // 1,000 free service messages per month
  approx(e.total!, 1.6875 + 2.0 + 7.0);
  assert.equal(ep.estimate(800, { whatsapp: true }).whatsapp, 0);
  const noHosting = ep.estimate(1500);
  assert.ok(noHosting.total === null && ep.toText(noHosting, 1500).includes("[to be measured]"));
});

test("the watch job of the TypeScript version is scheduled without a key", () => {
  const text = readFileSync(join(ROOT, "..", ".github", "workflows", "watch.yml"), "utf8");
  assert.ok(!text.includes("secrets.") && text.includes("id-token: write") && text.includes("cron:"));
  assert.ok(text.includes("npx tsx ch21/watch.ts") && text.includes("timeout-minutes:"));
});

// --- The same texts as the Python version ----------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

test("the same watch reports and the same estimates as the Python version", { skip: PYTHON_VENV ? false : "no Python environment" }, () => {
  const catalog: Record<string, watch.SeenModel> = {
    "claude-sonnet-5-5": model("claude-sonnet-5-5"), "claude-sonnet-4-5-20250929": model("claude-sonnet-4-5-20250929"),
    "claude-haiku-4-5-20251001": model("claude-haiku-4-5-20251001"), "claude-x-1": model("claude-x-1", "active", "2026-12-01T00:00:00Z"),
    "claude-y-1": model("claude-y-1", "deprecated"),
  };
  const used = { MODEL: "claude-sonnet-5-5", ROUTER_MODEL: "claude-haiku-4-5", DOCUMENTS_MODEL: "claude-sonnet-4-5-20250929", A: "claude-x-1", B: "claude-y-1", C: "claude-gone-1" };
  const estimates: [number, Record<string, unknown>][] = [
    [1500, { whatsapp: true, hosting: 7 }], [1500, {}], [800, { whatsapp: true, hosting: 12.5 }], [0, { hosting: 7 }], [40000, { whatsapp: true, messageCost: 0.0009, whatsappRate: 0.0113, hosting: 30 }],
  ];
  const ts = {
    models: [120, 30].map((h) => watch.examineModels(catalog, watch.publishedStates(PAGE), used, h, NOW).text()),
    sdk: [["0.137.0", "1.1.0"], ["1.1.0", "1.3.0"], ["1.1.0", "1.1.0"], ["1.1.0", null]].map(([i, l]) => watch.examineSdk(i!, l ?? null, "2026-10-21").text()),
    estimates: estimates.map(([n, o]) => ep.toText(ep.estimate(n, o), n)),
  };
  const script = `
import json, sys
from datetime import datetime, timezone
from types import SimpleNamespace
from ch21 import estimate_project as ep, watch
e = json.load(sys.stdin)
def model(m):
    retirement = datetime.fromisoformat(m["retires_at"].replace("Z", "+00:00")) if m["retires_at"] else None
    return SimpleNamespace(id=m["id"], lifecycle=m["lifecycle"], retires_at=retirement)
catalog = {k: model(v) for k, v in e["catalog"].items()}
now = datetime(2026, 10, 22, tzinfo=timezone.utc)
replace = lambda t: t.replace("anthropic SDK", "@anthropic-ai/sdk")
print(json.dumps({
    "models": [watch.examine_models(catalog, watch.published_states(e["page"]), e["used"], h, now).text() for h in (120, 30)],
    "sdk": [replace(watch.examine_sdk(i, l, "2026-10-21").text()) for i, l in e["sdk"]],
    "estimates": [ep.to_text(ep.estimate(n, o.get("messageCost", ep.COST_PER_MESSAGE), o.get("whatsapp", False),
                                         o.get("whatsappRate", ep.WHATSAPP_RATE), o.get("hosting")), n) for n, o in e["estimates"]],
}, ensure_ascii=False))`;
  const py = JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script], {
    cwd: PYTHON, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    input: JSON.stringify({ catalog, page: PAGE, used, sdk: [["0.137.0", "1.1.0"], ["1.1.0", "1.3.0"], ["1.1.0", "1.1.0"], ["1.1.0", null]], estimates }),
  }));
  assert.deepEqual(ts, py);
});
