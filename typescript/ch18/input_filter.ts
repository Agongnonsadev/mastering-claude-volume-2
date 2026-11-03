// Chapter 18: an input filter with Claude Haiku 5.5, measured before being plugged in.
//
// Anthropic's documentation suggests, against direct injection and jailbreaks, passing each message through
// a small model that classifies it before the conversation (“harmlessness screen”), with a structured
// output. This script measures it on messages whose answer is known: the 12 attacks of chapter 17 and 4 of
// this chapter, against 51 honest messages, including the 18 traps of chapter 17 (honest, but difficult). Two
// figures decide:
// - the attacks spotted: what the filter brings;
// - the honest messages wrongly flagged: what it would cost in customers badly served if it blocked.
// A refusal of the model (stop_reason “refusal”) counts as a flag, as the page advises.
//
// From the typescript/ folder:
//     npx tsx ch18/input_filter.ts --estimate                    (free)
//     npx tsx ch18/input_filter.ts --max-budget 0.1              (PAID, capped)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type MessagesClient, textOf } from "../comptoir/client.ts";
import { cost } from "../comptoir/costs.ts";
import { ROOT, isMain } from "../comptoir/launch.ts";
// The filter itself lives in comptoir/monitoring.ts since chapter 19, which plugs it in as monitoring.
import { MODEL, request } from "../comptoir/monitoring.ts";
import { pythonJson, str, sum } from "../comptoir/python.ts";
import { fixed, round } from "../comptoir/rounding.ts";
import { loadCases, timestamp } from "../ch17/suite.ts";
import { loadAttacks } from "./attack.ts";

export { INSTRUCTION, MODEL, SCHEMA, request } from "../comptoir/monitoring.ts"; // re-exported, as in Python

const ASSUMED_COST = 0.0005; // $ per message, generous

export interface LabeledMessage {
  source: string;
  id: string;
  message: string;
  attack: boolean;
}

/** The truth, written before running the filter. */
export function labeledMessages(): LabeledMessage[] {
  const output: LabeledMessage[] = loadCases().map((c) => ({ source: "ch17", id: c.id, message: c.message, attack: c.type === "security" }));
  const attacks = new Map(loadAttacks().map((a) => [a.id, a]));
  const [m1, m2, m3] = attacks.get("three-message-escalation")!.messages! as [string, string, string];
  const message = (id: string): string => attacks.get(id)!.message!;
  output.push(
    { source: "ch18", id: "escalation-1", message: m1, attack: false }, // on its own, this message is honest
    { source: "ch18", id: "escalation-2", message: m2, attack: true },
    { source: "ch18", id: "escalation-3", message: m3, attack: true },
    { source: "ch18", id: "fake-history", message: message("fake-history"), attack: true },
    { source: "ch18", id: "neighborhood-for-awa", message: message("neighborhood-for-awa"), attack: true },
    { source: "ch18", id: "pass-on-without-a-tool", message: message("pass-on-without-a-tool"), attack: false },
    { source: "ch18", id: "are-you-awa", message: message("are-you-awa"), attack: false },
  );
  return output;
}

export interface Verdict {
  flagged: boolean;
  stop: string | null;
  duration_s: number;
  cost_dollars: number;
}

export async function filterMessage(client: MessagesClient, message: string): Promise<Verdict> {
  const start = performance.now();
  const response = await client.messages.create(request(message));
  const duration = (performance.now() - start) / 1000;
  // A refusal: no verdict to read, counted as a flag.
  const flagged = response.stop_reason === "refusal" ? true : Boolean((JSON.parse(textOf(response)) as { manipulation: unknown }).manipulation);
  return { flagged, stop: response.stop_reason, duration_s: round(duration, 2), cost_dollars: round(cost(MODEL, response.usage).dollars, 6) };
}

export function summarize(results: (Pick<LabeledMessage, "id" | "attack"> & Pick<Verdict, "flagged" | "duration_s" | "cost_dollars">)[]): Record<string, unknown> {
  const attacks = results.filter((r) => r.attack);
  const honest = results.filter((r) => !r.attack);
  const durations = results.map((r) => r.duration_s).sort((a, b) => a - b);
  return {
    attacks_spotted: `${attacks.filter((r) => r.flagged).length} out of ${attacks.length}`,
    attacks_missed: attacks.filter((r) => !r.flagged).map((r) => r.id),
    honest_wrongly_flagged: `${honest.filter((r) => r.flagged).length} out of ${honest.length}`,
    false_flags: honest.filter((r) => r.flagged).map((r) => r.id),
    median_duration_s: durations.length ? durations[Math.floor(durations.length / 2)]! : null,
    total_cost_dollars: round(sum(results.map((r) => r.cost_dollars)), 4),
  };
}

/** Like ThreadPoolExecutor(max_workers=4).map: four at a time, the results in the order of the inputs. */
async function fourAtATime<I, O>(inputs: I[], f: (i: I) => Promise<O>): Promise<O[]> {
  const outputs: O[] = new Array(inputs.length);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < inputs.length) {
      const i = next++;
      outputs[i] = await f(inputs[i]!);
    }
  }));
  return outputs;
}

async function main(): Promise<number> {
  const { values: args } = parseArgs({ options: { estimate: { type: "boolean", default: false }, "max-budget": { type: "string", default: "0.1" } } });
  const messages = labeledMessages();
  const estimated = messages.length * ASSUMED_COST;
  console.log(`${messages.length} messages (${messages.filter((m) => m.attack).length} attacks); generous estimate: $${fixed(estimated, 2)}`);
  if (args.estimate || estimated > Number(args["max-budget"])) return args.estimate ? 0 : 1;

  const { makeClient } = await import("../comptoir/call.ts");
  const client = makeClient();
  const verdicts = await fourAtATime(messages, (m) => filterMessage(client, m.message));
  const results = messages.map((m, i) => ({ ...m, ...verdicts[i]! }));
  const summary = summarize(results);
  for (const [key, value] of Object.entries(summary)) console.log(`${key}: ${str(value)}`);
  const output = join(ROOT, "ch18", "results", `filter-${timestamp()}.json`);
  mkdirSync(join(ROOT, "ch18", "results"), { recursive: true });
  writeFileSync(output, pythonJson({ summary, results }, 1), "utf8");
  console.log(`→ ${output}`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await main();
