// Chapter 21: the Comptoir's watch. What changes at Anthropic without the Comptoir's code moving.
//
// From the typescript/ folder:
//     npx tsx ch21/watch.ts                    (free: the Models API generates nothing and consumes no token)
//     npx tsx ch21/watch.ts --horizon 180      (alert if a model in use is retired within 180 days)
//
// Three questions, every week, in CI:
// 1. Are the models the Comptoir calls still active, and until when? Two sources, crossed: the Model
//    deprecations page (the published state, the retirement date or “not sooner than…”) and the Models API
//    (what the key sees). On October 22, 2026, the API said “active” for a model that the page announced
//    retired on November 30: a single source would not have been enough. Anthropic warns at least 60 days
//    before the retirement of a published model.
// 2. Is the installed SDK up to date? sdk-versions.json gives the latest version of each SDK. One more major
//    version means a new version of the API: 1.0.0 of the TypeScript SDK moved to the API 2026-10-21 (its
//    changelog), like 2.0.0 of the Python SDK.
// 3. Which version of the API does the Comptoir send (anthropic-version header)?
//
// The exit code is 1 if there is an alert: the scheduled CI job fails, and someone looks.

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config } from "../comptoir/config.ts";
import { ROOT, isMain } from "../comptoir/launch.ts";

export const DEPRECATIONS_PAGE = "https://platform.claude.com/docs/en/about-claude/model-deprecations.md";
export const SDK_VERSIONS = "https://platform.claude.com/docs/sdk-versions.json";
const AGENT = { "User-Agent": "comptoir-watch/1.0" }; // the site refuses some default clients (403)
const MODEL = /\bclaude-(?:fable|mythos|opus|sonnet|haiku)-\d+(?:-\d+)?(?:-\d{8})?\b/g;
const SETTINGS = ["MODEL", "ROUTER_MODEL", "DOCUMENTS_MODEL", "AUXILIARY_MODEL", "COMPTOIR_MODEL"] as const;
const TABLE_ROW = /^\|\s*(claude-[a-z0-9-]+)\s*\|\s*([A-Za-z]+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|$/gm;
const DAY_MS = 86_400_000;

/** What the deprecations page says about a model. */
export interface State {
  state: string; //                Active, Legacy, Deprecated, Retired
  deprecatedOn: string | null;
  retirement: Date | null; //      the date set, or the one before which there will be no retirement
  notBefore: boolean; //           “Not sooner than”: a floor date, not a set date
}

/** What the Models API returns about a model, that the watch uses. */
export interface SeenModel {
  id: string;
  lifecycle: string;
  retires_at?: string | null;
}

export class Report {
  readonly alerts: string[] = [];
  readonly infos: string[] = [];

  text(): string {
    return [...this.alerts.map((a) => `ALERT   ${a}`), ...this.infos.map((i) => `        ${i}`)].join("\n") || "Nothing to report.";
  }
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** “November 30, 2026” (strptime "%B %d, %Y"), in UTC; null if the date cannot be read. */
export function readDate(text: string): Date | null {
  const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(text.trim());
  const month = m ? MONTHS.findIndex((name) => name.toLowerCase() === m[1]!.toLowerCase()) : -1;
  if (!m || month < 0) return null;
  const date = new Date(Date.UTC(Number(m[3]), month, Number(m[2])));
  return date.getUTCDate() === Number(m[2]) ? date : null;
}

/** The “Model status” table of the deprecations page, in Markdown. */
export function publishedStates(page: string): Record<string, State> {
  const states: Record<string, State> = {};
  for (const [, modelId, state, deprecated, retirement] of page.replace(/\r\n/g, "\n").matchAll(TABLE_ROW)) {
    const floor = retirement!.toLowerCase().startsWith("not sooner than");
    states[modelId!] = {
      state: state!, deprecatedOn: deprecated === "N/A" || deprecated === "" ? null : deprecated!,
      retirement: readDate(retirement!.replace(/^not sooner than\s+/i, "")), notBefore: floor,
    };
  }
  return states;
}

export async function download(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: AGENT, signal: AbortSignal.timeout(20_000) });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

/** Setting -> model, as comptoir/config.ts reads them (environment variables included). */
export const modelsInProduction = (): Record<string, string> => Object.fromEntries(SETTINGS.map((name) => [name, config[name]]));

/** Model -> files where it is written, except dependencies, results, tests, built packages and this file. */
export function modelsOfTheRepository(root = ROOT): Record<string, Set<string>> {
  const found: Record<string, Set<string>> = {};
  const here = fileURLToPath(import.meta.url);
  for (const f of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!f.isFile() || !f.name.endsWith(".ts")) continue;
    const path = join(f.parentPath, f.name);
    const rel = relative(root, path).replaceAll("\\", "/");
    if (/^(node_modules|tests)\//.test(rel) || rel.includes("/node_modules/") || rel.includes("/results/") || rel.includes("/build/") || path === here) continue;
    for (const model of new Set(readFileSync(path, "utf8").match(MODEL) ?? [])) (found[model] ??= new Set()).add(rel);
  }
  return found;
}

/** The exact model, or the dated version whose ID is an alias (…-4-5 -> …-4-5-20251001). */
export function find<T>(models: Record<string, T>, modelId: string): T | null {
  if (modelId in models) return models[modelId]!;
  const dated = Object.entries(models).filter(([i]) => i.startsWith(modelId + "-"));
  return dated.length === 1 ? dated[0]![1] : null;
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

/** catalog: ID -> model of the Models API; published: the deprecations page (null if unreachable). */
export function examineModels(catalog: Record<string, SeenModel>, published: Record<string, State> | null, used: Record<string, string>, horizonDays: number, now: Date): Report {
  const report = new Report();
  if (published === null) report.alerts.push("Deprecations page unreachable: only the Models API was read");
  for (const modelId of [...new Set(Object.values(used))].sort()) {
    const where = Object.keys(used).filter((k) => used[k] === modelId).sort().join(", ");
    const api = find(catalog, modelId);
    const page = find(published ?? {}, modelId);
    if (api === null) report.alerts.push(`${modelId} (${where}): missing from the Models API — retired, or not accessible with this key`);
    if (page !== null && page.state !== "Active") {
      const when = page.retirement && !page.notBefore ? `, retirement on ${day(page.retirement)}` : "";
      report.alerts.push(`${modelId} (${where}): “${page.state}” according to the deprecations page${when}`);
      if (api !== null && api.lifecycle === "active") report.alerts.push(`${modelId}: the Models API still says “active”; the page is authoritative`);
      continue;
    }
    if (api !== null && api.lifecycle !== "active") {
      report.alerts.push(`${modelId} (${where}): “${api.lifecycle}” according to the Models API`);
      continue;
    }
    const retirement = api?.retires_at ? new Date(api.retires_at) : page && !page.notBefore ? page.retirement : null;
    if (retirement && retirement.getTime() - now.getTime() <= horizonDays * DAY_MS) {
      report.alerts.push(`${modelId} (${where}): retirement on ${day(retirement)}, in ${Math.floor((retirement.getTime() - now.getTime()) / DAY_MS)} days`);
    } else if (api !== null) {
      const floor = page && page.notBefore && page.retirement ? `, not before ${day(page.retirement)}` : "";
      report.infos.push(`${modelId} (${where}): active${floor}`);
    }
  }
  return report;
}

export const major = (version: string): number => Number(version.split(".")[0]);

export function examineSdk(installed: string, latest: string | null, apiVersion: string): Report {
  const report = new Report();
  if (latest === null) {
    report.alerts.push("Latest SDK version unknown: sdk-versions.json unreachable");
  } else if (major(latest) > major(installed)) {
    report.alerts.push(
      `@anthropic-ai/sdk ${installed} installed, ${latest} available: one more major version, ` +
        "hence a new API version. Read the migration guide before changing.",
    );
  } else if (latest !== installed) {
    report.infos.push(`@anthropic-ai/sdk ${installed} installed, ${latest} available (same major version)`);
  } else {
    report.infos.push(`@anthropic-ai/sdk ${installed}: up to date`);
  }
  report.infos.push(`API version sent: ${apiVersion}`);
  return report;
}

/** The installed version of the SDK, read in its package.json. */
export const installedVersion = (): string =>
  (JSON.parse(readFileSync(join(ROOT, "node_modules", "@anthropic-ai", "sdk", "package.json"), "utf8")) as { version: string }).version;

/**
 * The anthropic-version header that the installed SDK sends by default. No request is made: the client
 * receives a local fetch, which records the headers and answers by itself.
 */
export async function apiVersionSent(): Promise<string> {
  let version = "?";
  const client = new Anthropic({
    apiKey: "none", maxRetries: 0,
    fetch: async (_url, options) => {
      version = new Headers(options?.headers).get("anthropic-version") ?? "?";
      return Response.json({ data: [], has_more: false, first_id: null, last_id: null });
    },
  });
  await client.models.list();
  return version;
}

async function main(): Promise<number> {
  const { values: args } = parseArgs({ options: { horizon: { type: "string", default: "120" } } }); // days before a retirement to raise an alert
  const now = new Date();
  const { makeClient } = await import("../comptoir/call.ts");
  const page = await download(DEPRECATIONS_PAGE);
  const published = page ? publishedStates(page) : null;
  const production = modelsInProduction();
  const catalog: Record<string, SeenModel> = {};
  for await (const m of makeClient().models.list()) catalog[m.id] = m;
  const report = examineModels(catalog, published, production, Number(args.horizon), now);
  const versions = await download(SDK_VERSIONS);
  const sdk = examineSdk(installedVersion(), versions ? ((JSON.parse(versions) as Record<string, string>).typescript ?? null) : null, await apiVersionSent());
  const date = `${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()}, ${now.getUTCFullYear()}`; // in UTC
  console.log(`Watch of ${date}\n\nThe Comptoir's models in production:\n${report.text()}\n`);
  console.log("SDK and API:\n" + sdk.text() + "\n");
  const inProduction = new Set(Object.values(production));
  const others = Object.entries(modelsOfTheRepository()).filter(([m]) => !inProduction.has(m)).sort(([a], [b]) => (a < b ? -1 : 1));
  if (others.length) {
    console.log("Other models written in the repository (chapter scripts, comparisons):");
    for (const [model, files] of others) {
      const state = find(published ?? {}, model);
      console.log(`        ${model} (${state ? state.state : "unknown state"}): ${[...files].sort().join(", ")}`);
    }
  }
  return report.alerts.length || sdk.alerts.length ? 1 : 0;
}

if (isMain(import.meta.url)) process.exitCode = await main();
