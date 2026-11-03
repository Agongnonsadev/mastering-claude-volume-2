// Chapter 14: three questions from Yao to Claude Code, on the copy of the orders, through MCP.
//
// Run, from the typescript/ folder (PAID CALL: Claude Code uses your API key):
//     npx tsx ch14/measure_claude_code.ts --claude "path/to/claude" --max-budget 0.40
//
// Each question is asked in a fresh `claude -p` session, launched from the python/ folder, which loads the
// MCP server of python/.mcp.json (project scope). Only the two tools of the orders server are allowed; any
// other tool is refused (--permission-mode dontAsk). Each answer is compared with the right answers
// calculated by the code (ch14/truths.ts), and the cost is read in the JSON output.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AFTER, BEFORE } from "../comptoir/guard.ts";
import { ROOT as TS_ROOT, isMain } from "../comptoir/launch.ts";
import { pythonJson } from "../comptoir/python.ts";
import { fixed } from "../comptoir/rounding.ts";
import { ROOT } from "./servers.ts";
import { type Truths, compute } from "./truths.ts";

export const TOOLS = "mcp__orders__execute_sql,mcp__orders__search_objects";
export const RESULTS = join(TS_ROOT, "ch14", "results");
export const MODEL = "claude-sonnet-5-5"; // the Comptoir's model (chapter 3)

export const QUESTIONS: [string, string][] = [
  ["schema", "Describe the orders database plugged in through MCP: which tables, and how is an order linked to its products and to the customer's neighborhood? Answer in five lines at most."],
  ["neighborhoods", "From Monday, September 21 to Sunday, October 18, 2026, which three neighborhoods brought in the most, in FCFA, and how many orders for each? Give the exact amounts."],
  [
    "abandonments",
    "How many conversations received at least one summary without any of them becoming an order, out of how many conversations in total? At what hour of the day is the abandonment rate highest (among the hours with at least 20 summaries)?",
  ],
];

// Python's \d and \b, over all digits and all letters (JavaScript's \s already includes the no-break
// spaces, U+00A0 and U+202F, which the Python version adds by hand).
const DIGIT = "\\p{Nd}";
const SEPARATOR = new RegExp(`(?<=${DIGIT})[\\s.,](?=${DIGIT}{3}${AFTER})`, "gu");

/** “194,500” or “194 500” or “194.500”: the figures are compared without their separators. */
export const digits = (text: string): string => text.replace(SEPARATOR, "");

const containsNumber = (text: string, n: number | string): boolean => new RegExp(`${BEFORE}${n}${AFTER}`, "u").test(text);

/** 11 -> “11:00”, “11h”, “11 a.m.”, “11am”; 18 -> “18:00”, “18h”, “6 p.m.”, “6pm”. */
export function hourPattern(hour: number): string {
  const twelve = hour % 12 || 12;
  const suffix = hour < 12 ? `a\\.?m${AFTER}\\.?` : `p\\.?m${AFTER}\\.?`;
  return `${BEFORE}${hour}:00|${BEFORE}${hour}\\s*h${AFTER}|${BEFORE}${twelve}\\s*${suffix}` + (hour === 12 ? `|${BEFORE}noon${AFTER}` : "");
}

/** The gaps between the answer and what the code calculated. Empty list: right answer. */
export function check(question: string, answer: string, truths: Pick<Truths, "neighborhoods" | "abandonments" | "conversations" | "worst_abandonment_hour">): string[] {
  const text = digits(answer);
  const gaps: string[] = [];
  if (question === "schema") {
    for (const word of ["summaries", "orders", "lines", "neighborhood"]) {
      if (!text.toLowerCase().includes(word)) gaps.push(`does not mention “${word}”`);
    }
    if (!text.toLowerCase().includes("json")) gaps.push("does not say that the lines are JSON");
  } else if (question === "neighborhoods") {
    for (const n of truths.neighborhoods) {
      if (!answer.includes(n.neighborhood)) gaps.push(`missing neighborhood: ${n.neighborhood}`);
      if (!text.includes(String(n.fcfa))) gaps.push(`missing amount for ${n.neighborhood}: ${n.fcfa}`);
      if (!containsNumber(text, n.orders)) gaps.push(`missing number of orders for ${n.neighborhood}: ${n.orders}`);
    }
  } else if (question === "abandonments") {
    for (const key of ["abandonments", "conversations"] as const) {
      if (!containsNumber(text, truths[key])) gaps.push(`${key}: ${truths[key]} expected`);
    }
    const hour = truths.worst_abandonment_hour;
    if (!new RegExp(hourPattern(hour), "iu").test(text)) gaps.push(`expected hour: ${hour}:00`);
  }
  return gaps;
}

export function ask(claude: string, question: string, budget: number): Record<string, unknown> {
  const command = ["-p", question, "--model", MODEL, "--output-format", "json", "--allowedTools", TOOLS, "--permission-mode", "dontAsk",
    "--max-budget-usd", fixed(budget, 2), "--no-session-persistence"];
  const output = spawnSync(claude, command, { cwd: ROOT, encoding: "utf8", timeout: 600_000 });
  if (output.error) throw output.error;
  if (output.status !== 0 && !output.stdout.trim()) throw new Error(`claude -p failed: ${output.stderr.slice(-800)}`);
  return JSON.parse(output.stdout) as Record<string, unknown>;
}

/** datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"). */
const timestamp = (): string => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      claude: { type: "string", default: "claude" }, //             the claude program (Claude Code)
      "max-budget": { type: "string", default: "0.40" }, //          ceiling per question, in dollars
      only: { type: "string" },
    },
  });
  const names = QUESTIONS.map(([n]) => n);
  if (args.only !== undefined && !names.includes(args.only)) {
    console.error(`error: --only to choose from ${names.join(", ")}`);
    process.exit(2);
  }
  const truths = compute();
  mkdirSync(RESULTS, { recursive: true });
  let total = 0;
  for (const [name, question] of QUESTIONS) {
    if (args.only && name !== args.only) continue;
    const result = ask(args.claude, question, Number(args["max-budget"]));
    const answer = String(result.result ?? "");
    const gaps = check(name, answer, truths);
    const cost = Number(result.total_cost_usd ?? 0);
    total += cost;
    writeFileSync(join(RESULTS, `${timestamp()}-${name}.json`), pythonJson({ question, gaps, output: result }, 2), "utf8");
    console.log(`\n=== ${name}: ${gaps.length ? "GAPS: " + gaps.join("; ") : "right"}`);
    console.log(`${result.num_turns} turns, $${fixed(cost, 4)}, stop: ${result.subtype}`);
    console.log([...answer.trim()].slice(0, 1500).join(""));
  }
  console.log(`\nTotal cost: $${fixed(total, 4)}`);
}

if (isMain(import.meta.url)) await main();
