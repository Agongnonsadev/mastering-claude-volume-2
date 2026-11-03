// Chapter 19: the judge of chapter 17, through the Batch API. Half the price, and the same grade?
//
// From the typescript/ folder:
//     npx tsx ch19/judge_in_batch.ts <series> --estimate                     (free)
//     npx tsx ch19/judge_in_batch.ts <series> --max-wait 3600                (PAID, a batch)
//     npx tsx ch19/judge_in_batch.ts <series> --reread <batch>               (free: reread a finished batch)
//     npx tsx ch19/judge_in_batch.ts <series> --compare                      (free: the batch's file, without a call)
//
// The judgments of a chapter 17 series are not in a hurry: they are done at night, or while Yao does
// something else. Each judgment becomes a request of the batch, identical to that of the live judge
// (ch17/judge.ts), cached documents included: the documentation warns that the cache, in a batch, only serves
// “on a best-effort basis”, the requests going through in any order. The script writes the judgments next to
// those of the live judge (judgments-<model>-<rubric>-batch.jsonl) and compares: the cost, the duration, and
// the agreement between the two judges, since the same judge never gives exactly the same grade twice.

import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { parseArgs } from "node:util";
import { textOf } from "../comptoir/client.ts";
import { cost } from "../comptoir/costs.ts";
import { isMain } from "../comptoir/launch.ts";
import { logCall } from "../comptoir/log.ts";
import { pythonJson, sum } from "../comptoir/python.ts";
import { fixed, round } from "../comptoir/rounding.ts";
import { identifier } from "../ch17/harness.ts";
import * as judge_ from "../ch17/judge.ts";
import { type WrittenJudgment, jsonLine, loadCases, outcome, readJudgments, readSeries } from "../ch17/suite.ts";
import type { BatchClient } from "./evening_summary.ts";

const ASSUMED_PRICE = 0.0002; // $ per judgment in batch, generous ($0.0004 live in chapter 17)

/** custom_id: letters, digits, hyphens and underscores, 64 characters at most. */
export const batchId = (trialId: string): string => trialId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);

export function requests(folder: string, model: string): [{ custom_id: string; params: Anthropic.MessageCreateParamsNonStreaming }[], Record<string, string>] {
  const cases = new Map(loadCases().map((c) => [c.id, c]));
  const rubric = judge_.loadRubric();
  const batchRequests: { custom_id: string; params: Anthropic.MessageCreateParamsNonStreaming }[] = [];
  const mapping: Record<string, string> = {};
  for (const trial of readSeries(folder)) {
    if (trial.error) continue;
    const key = batchId(identifier(trial));
    // Two trials reduced to the same custom_id: their results would mix.
    if (key in mapping) throw new Error(`duplicate custom_id: ${key}`);
    mapping[key] = identifier(trial);
    batchRequests.push({ custom_id: key, params: judge_.request(cases.get(trial.case)!, trial, model, rubric) });
  }
  return [batchRequests, mapping];
}

export async function readResults(client: BatchClient, batch: string, mapping: Record<string, string>, model: string): Promise<judge_.Judgment[]> {
  const rubric = judge_.loadRubric();
  const judgments: judge_.Judgment[] = [];
  for await (const entry of await client.messages.batches.results(batch)) {
    const j: judge_.Judgment = { trial: mapping[entry.custom_id]!, model, rubric: rubric.id, verdicts: {}, findings: {}, cost_dollars: 0, error: null };
    if (entry.result.type !== "succeeded") {
      j.error = `batch: ${entry.result.type}`;
      judgments.push(j);
      continue;
    }
    const message = entry.result.message!;
    const price = cost(model, message.usage, true);
    logCall(message.id, model, price, { prompt: rubric.id, stop_reason: message.stop_reason, batch });
    j.cost_dollars = round(price.dollars, 6);
    if (message.stop_reason !== "end_turn") {
      j.error = `judgment stopped by ${message.stop_reason}`;
    } else {
      const data = JSON.parse(textOf(message)) as Record<string, { finding: string; verdict: string }>;
      for (const c of judge_.CRITERIA) {
        j.verdicts[c] = data[c]!.verdict;
        j.findings[c] = data[c]!.finding;
      }
    }
    judgments.push(j);
  }
  return judgments;
}

/** A judgment read back from a file, without the computed fields written into it (“outcome”). */
export function judgment(data: Partial<judge_.Judgment> & { trial: string }): judge_.Judgment {
  const { trial, model = "", rubric = "", verdicts = {}, findings = {}, cost_dollars = 0, error = null } = data;
  return { trial, model, rubric, verdicts, findings, cost_dollars, error };
}

export function compare(inBatch: judge_.Judgment[], live: Record<string, WrittenJudgment>): Record<string, unknown> {
  const common = inBatch.filter((j) => j.trial in live && !j.error);
  const sameOutcome = common.filter((j) => outcome(j) === outcome(judgment(live[j.trial]!))).length;
  // Like verdicts.get(c) == …get(c) in Python: two missing verdicts count as the same.
  const criteria = common.reduce((n, j) => n + judge_.CRITERIA.filter((c) => (j.verdicts[c] ?? null) === (live[j.trial]!.verdicts[c] ?? null)).length, 0);
  return {
    compared_judgments: common.length,
    same_outcome: sameOutcome,
    same_verdicts: `${criteria} out of ${common.length * judge_.CRITERIA.length}`,
    batch_cost: round(sum(inBatch.map((j) => j.cost_dollars)), 4),
    live_cost: round(sum(common.map((j) => live[j.trial]!.cost_dollars)), 4),
    batch_errors: inBatch.filter((j) => j.error).map((j) => j.error),
  };
}

function writeReport(folder: string, model: string, header: Record<string, unknown>, judgments: judge_.Judgment[]): number {
  const report = { ...header, ...compare(judgments, readJudgments(folder, model, judge_.RUBRIC)) };
  console.log(pythonJson(report, 1));
  writeFileSync(join(folder, `batch-${model}-${judge_.RUBRIC}.json`), pythonJson(report, 1), "utf8");
  return 0;
}

async function main(): Promise<number> {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: "string", default: "claude-haiku-5-5" },
      estimate: { type: "boolean", default: false },
      "max-wait": { type: "string", default: "3600" },
      reread: { type: "string" }, //                   a batch already launched
      compare: { type: "boolean", default: false }, //  the batch's file already read, without a call
    },
  });
  const folder = positionals[0];
  if (!folder) throw new Error("The series to judge: npx tsx ch19/judge_in_batch.ts <series>.");
  const [batchRequests, mapping] = requests(folder, args.model);
  console.log(`${batchRequests.length} judgments; generous estimate: $${fixed(batchRequests.length * ASSUMED_PRICE, 3)}`);
  if (args.estimate) return 0;
  const output = join(folder, `judgments-${args.model}-${judge_.RUBRIC}-batch.jsonl`);
  if (args.compare) {
    if (!existsSync(output)) throw new Error(`No batch file: ${output}`);
    const judgments = readFileSync(output, "utf8").split("\n").filter((l) => l.trim()).map((l) => judgment(JSON.parse(l)));
    return writeReport(folder, args.model, { batch: null, duration_s: null }, judgments);
  }

  const { makeClient } = await import("../comptoir/call.ts");
  const client = makeClient() as unknown as BatchClient;
  const start = performance.now();
  let batch = args.reread;
  if (!batch) {
    batch = (await client.messages.batches.create({ requests: batchRequests })).id;
    console.log(`Batch ${batch} created.`);
    for (let state = await client.messages.batches.retrieve(batch); state.processing_status !== "ended"; state = await client.messages.batches.retrieve(batch)) {
      const elapsed = (performance.now() - start) / 1000;
      if (elapsed > Number(args["max-wait"])) {
        console.log(`Not finished after ${Number(args["max-wait"]).toFixed(0)} s; run again with --reread ${batch}`);
        return 1;
      }
      console.log(`  ${elapsed.toFixed(0).padStart(5)} s: ${JSON.stringify(state.request_counts)}`);
      await wait(30_000);
    }
  }
  const duration = round((performance.now() - start) / 1000, 1);
  const judgments = await readResults(client, batch, mapping, args.model);
  writeFileSync(output, judgments.map((j) => jsonLine(j) + "\n").join(""), "utf8");
  return writeReport(folder, args.model, { batch, duration_s: args.reread ? null : duration }, judgments);
}

if (isMain(import.meta.url)) process.exitCode = await main();
