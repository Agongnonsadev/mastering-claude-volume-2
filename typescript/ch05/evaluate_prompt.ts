// Chapter 5: compare version 0 of the prompt (chapter 2) and version 1, on 20 cases.
//
// Only one thing changes between the two variants: the system prompt (and the tag around the customer's
// message, which goes with it). The model, the effort and max_tokens are the same.
//
// Run, from the typescript/ folder:
//     npx tsx ch05/evaluate_prompt.ts --estimate
//     npx tsx ch05/evaluate_prompt.ts --repetitions 3 --max-budget 1
//     npx tsx ch05/evaluate_prompt.ts --regrade     (free: the current grid, on the answers already obtained)
//     npx tsx ch05/evaluate_prompt.ts --regrade --trials ../python/ch05/results/trials.csv

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SYSTEM_PROMPT as PROMPT_V0 } from "../ch02/comptoir_cli.ts";
import { MAX_TOKENS, buildRequest } from "../comptoir/assistant.ts";
import type { MessagesClient } from "../comptoir/client.ts";
import { config } from "../comptoir/config.ts";
import { RATES } from "../comptoir/costs.ts";
import { type Trial, type Variant, evaluate, readCsv, regrade, regressions, summarize, writeCsv } from "../comptoir/evaluation.ts";
import { PYTHON, ROOT, isMain } from "../comptoir/launch.ts";
import { type Case, makeCase } from "../comptoir/notation.ts";
import { load } from "../comptoir/prompt.ts";

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

export function requestV0(c: Case): Anthropic.MessageCreateParamsNonStreaming {
  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model: config.MODEL,
    max_tokens: MAX_TOKENS,
    system: PROMPT_V0,
    messages: [{ role: "user", content: c.question }],
  };
  if (config.EFFORT) request.output_config = { effort: config.EFFORT as Effort };
  return request;
}

export function requestV1(c: Case): Anthropic.MessageCreateParamsNonStreaming {
  return buildRequest(c.question, { prompt: load("v1") });
}

export const VARIANTS: Record<string, Variant> = { v0: requestV0, v1: requestV1 };

/** The chapter's 20 cases, those of the Python version (python/ch05/cases.json). */
export function loadCases(): Case[] {
  return (JSON.parse(readFileSync(join(PYTHON, "ch05", "cases.json"), "utf8")) as Parameters<typeof makeCase>[0][]).map(makeCase);
}

export async function estimate(client: MessagesClient, cases: Case[], repetitions: number, assumedOutput: number): Promise<number> {
  const rate = RATES[config.MODEL];
  if (!rate) throw new Error(`Unknown price for the model '${config.MODEL}': add it to RATES.`);
  let total = 0;
  for (const build of Object.values(VARIANTS)) {
    for (const c of cases) {
      const { model, system, messages } = build(c);
      const { input_tokens: input } = await client.messages.countTokens({ model, system, messages });
      total += (repetitions * (input * rate.input + assumedOutput * rate.output)) / 1_000_000;
    }
  }
  return total;
}

export function show(trials: Trial[]): void {
  for (const line of summarize(trials)) {
    const perSuccess = line.costPerSuccess ? `$${line.costPerSuccess.toFixed(5)}` : "—";
    console.log(
      `${line.variant}: success ${Math.round(line.success * 100)}% · ${perSuccess} per success · ` +
        `median latency ${line.medianLatencyS.toFixed(1)} s`,
    );
  }
  const lost = regressions(trials, "v0", "v1");
  console.log("Regressions of v1 compared with v0:", lost.length ? lost.join(", ") : "none");
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      repetitions: { type: "string", default: "3" },
      "max-budget": { type: "string", default: "1.0" },
      estimate: { type: "boolean", default: false },
      "assumed-output": { type: "string", default: "250" },
      regrade: { type: "boolean", default: false },
      // The answers to regrade: those of this version by default; those of Python can be regraded.
      trials: { type: "string", default: join(ROOT, "ch05", "results", "trials.csv") },
    },
  });
  const repetitions = Number(args.repetitions);

  if (args.regrade) {
    const source = resolve(args.trials);
    const trials = regrade(readCsv(source), loadCases());
    writeCsv(trials, join(ROOT, "ch05", "results", "trials-regraded.csv"));
    console.log(`Answers read back from ${source}`);
    show(trials);
    return;
  }

  const client = new Anthropic();
  const cases = loadCases();
  console.log(`Model: ${config.MODEL} · effort: ${config.EFFORT ?? "default"} · prompt v1: ${load("v1").id}`);
  if (args.estimate) {
    const total = await estimate(client, cases, repetitions, Number(args["assumed-output"]));
    console.log(`Estimated cost: $${total.toFixed(2)} (${cases.length} cases × 2 versions × ${repetitions} repetitions)`);
    return;
  }

  const trials = await evaluate(client, cases, VARIANTS, repetitions, Number(args["max-budget"]));
  writeCsv(trials, join(ROOT, "ch05", "results", "trials.csv"));
  show(trials);
}

if (isMain(import.meta.url)) await main();
