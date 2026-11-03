// Chapter 8: the Comptoir's dashboard, drawn from the log. No call to the API.
//
// Run, from the typescript/ folder:
//     npx tsx ch08/dashboard.ts
//     npx tsx ch08/dashboard.ts --html log/dashboard.html
//     npx tsx ch08/dashboard.ts --log ../python/log/calls.jsonl   (the log of the Python version)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { config } from "../comptoir/config.ts";
import { byDay, failureModes, latencies, load, toHtml, toPickUp } from "../comptoir/dashboard.ts";

const { values: args } = parseArgs({
  options: {
    log: { type: "string", default: config.LOG },
    html: { type: "string" }, // also write an HTML page at this path
  },
});

const lines = load(args.log);
console.log("Day         Calls   Cost ($)   Failures");
for (const [day, d] of byDay(lines)) {
  console.log(`${day}  ${String(d.calls).padStart(5)}  ${d.dollars.toFixed(4).padStart(9)}  ${String(d.failures).padStart(9)}`);
}
const [median, p95] = latencies(lines);
if (median !== null) console.log(`\nLatency of successful calls: median ${median.toFixed(0)} ms, 95th percentile ${p95!.toFixed(0)} ms`);
const failures = failureModes(lines);
if (failures.length) {
  console.log("\nFailure modes (origin, code):");
  for (const { origin, code, count } of failures) console.log(`  ${origin.padEnd(12)} ${code.padEnd(22)} ${count}`);
}
const pickUp = toPickUp(lines);
if (pickUp.length) {
  console.log("\nConversations for Awa to pick up:");
  for (const r of pickUp) console.log(`  ${r.date}  ${r.conversation}  (${r.reason})`);
}
if (args.html) {
  mkdirSync(dirname(args.html), { recursive: true });
  writeFileSync(args.html, toHtml(lines), "utf8");
  console.log(`\nPage written: ${args.html}`);
}
