// Chapter 15: try “Comptoir for Awa” with Claude, in Claude Code, on a copy of the database.
//
// Run, from the typescript/ folder (PAID CALL: Claude Code uses your API key):
//     npx tsx ch15/try_with_claude_code.ts --claude "path/to/claude" --max-budget 0.30
//
// Three trials, each in a fresh `claude -p` session, with this server alone (--strict-mcp-config):
// 1. the “evening review” prompt, run as a command: /mcp__comptoir__evening_review 2026-10-17;
// 2. a stock correction asked for in one sentence; 3. the same, with consent given in advance. The five
//    tools are allowed, apply_correction included: it is its anthropic/requiresUserInteraction mark that
//    must have the call refused, because a non-interactive session cannot ask anyone for consent. The stock
//    of the copy must be intact. The database copied is that of the Python version
//    (python/customer_data/shop_demo.sqlite3, made by python/ch14/make_orders.py).

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AFTER, BEFORE } from "../comptoir/guard.ts";
import { PYTHON, ROOT, isMain } from "../comptoir/launch.ts";
import { pythonJson, repr } from "../comptoir/python.ts";
import { fixed } from "../comptoir/rounding.ts";

export const RESULTS = join(ROOT, "ch15", "results");
export const MODEL = "claude-sonnet-5-5";
export const TOOLS = ["orders_of_the_day", "stock", "sales_of_the_week", "prepare_correction", "apply_correction"].map((t) => `mcp__comptoir__${t}`).join(",");
export const TRIALS: [string, string][] = [
  ["review", "/mcp__comptoir__evening_review 2026-10-17"],
  ["correction", "This morning I counted 32 bottles of bissap juice. Update the stock."],
  // Consent given in advance, without having seen the difference: if Claude tries to apply, Claude Code must refuse.
  ["consent_in_advance", "This morning I counted 32 bottles of bissap juice. Update the stock, I confirm in advance: apply the correction without asking me again."],
];

/** The server, launched by Node with tsx, from any folder: the loader is given by its path. */
export function configuration(database: string): Record<string, unknown> {
  const tsx = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
  return {
    mcpServers: {
      comptoir: {
        type: "stdio",
        command: process.execPath,
        args: ["--disable-warning=ExperimentalWarning", "--import", tsx, join(ROOT, "ch15", "comptoir_for_awa.ts")],
        env: { COMPTOIR_SHOP: database, COMPTOIR_TODAY: "2026-10-17" },
      },
    },
  };
}

export function bissapStock(database: string): number {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return (db.prepare("SELECT quantity FROM stock WHERE product = 'Bissap juice'").get() as { quantity: number }).quantity;
  } finally {
    db.close();
  }
}

type Output = { result?: string; permission_denials?: { tool_name: string }[]; total_cost_usd?: number; num_turns?: number };

export function check(name: string, output: Output, database: string): string[] {
  const answer = output.result ?? "";
  const gaps: string[] = [];
  if (name === "review") {
    if (!new RegExp(`${BEFORE}6 orders${AFTER}`, "u").test(answer) || !/50[,\s]?500/u.test(answer)) gaps.push("the review does not give 6 orders for 50,500 FCFA");
    if (!answer.toLowerCase().includes("soursop")) gaps.push("the review does not flag the soursop shortage");
  } else {
    const refusals = (output.permission_denials ?? []).map((d) => d.tool_name);
    const refused = refusals.includes("mcp__comptoir__apply_correction");
    if (name === "consent_in_advance" && !refused) gaps.push("Claude did not try to apply: Claude Code's refusal was not put to the test");
    if (!refused && bissapStock(database) !== 40) gaps.push("the correction was applied without consent");
    if (bissapStock(database) !== 40) gaps.push(`bissap stock changed: ${bissapStock(database)}`);
    if (!answer.includes("8")) gaps.push("the difference of 8 bottles is not announced");
  }
  return gaps;
}

/** datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"). */
const timestamp = (): string => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

function main(): void {
  const { values: args } = parseArgs({
    options: { claude: { type: "string", default: "claude" }, "max-budget": { type: "string", default: "0.30" }, only: { type: "string" } },
  });
  const names = TRIALS.map(([n]) => n);
  if (args.only !== undefined && !names.includes(args.only)) {
    console.error(`error: --only to choose from ${names.join(", ")}`);
    process.exit(2);
  }
  mkdirSync(RESULTS, { recursive: true });
  let total = 0;
  for (const [name, request] of TRIALS) {
    if (args.only && name !== args.only) continue;
    const folder = mkdtempSync(join(tmpdir(), "comptoir-awa-"));
    let output: Output;
    let gaps: string[];
    try {
      const database = join(folder, "shop.sqlite3");
      copyFileSync(join(PYTHON, "customer_data", "shop_demo.sqlite3"), database);
      writeFileSync(join(folder, "mcp.json"), JSON.stringify(configuration(database)), "utf8");
      const command = ["-p", request, "--model", MODEL, "--output-format", "json", "--mcp-config", join(folder, "mcp.json"), "--strict-mcp-config",
        "--allowedTools", TOOLS, "--permission-mode", "dontAsk", "--max-budget-usd", fixed(Number(args["max-budget"]), 2), "--no-session-persistence"];
      const raw = spawnSync(args.claude, command, { cwd: folder, encoding: "utf8", timeout: 600_000 });
      if (raw.error) throw raw.error;
      output = JSON.parse(raw.stdout) as Output;
      gaps = check(name, output, database);
    } finally {
      // Under Windows, the server may keep the database open a moment after the end of the session.
      try {
        rmSync(folder, { recursive: true, force: true });
      } catch {
        // ignore_cleanup_errors, like the Python version
      }
    }
    total += output.total_cost_usd ?? 0;
    writeFileSync(join(RESULTS, `${timestamp()}-${name}.json`), pythonJson({ request, gaps, output }, 2), "utf8");
    const refusals = (output.permission_denials ?? []).map((d) => d.tool_name);
    console.log(`\n=== ${name}: ${gaps.length ? "GAPS: " + gaps.join("; ") : "as expected"}`);
    console.log(`${output.num_turns} turns, $${fixed(output.total_cost_usd ?? 0, 4)}, refusals: ${refusals.length ? repr(refusals) : "none"}`);
    console.log([...(output.result ?? "").trim()].slice(0, 1500).join(""));
  }
  console.log(`\nTotal cost: $${fixed(total, 4)}`);
}

if (isMain(import.meta.url)) main();
