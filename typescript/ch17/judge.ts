// Grading by Claude, with a rubric (chapter 17).
//
// The judge reads what the code cannot judge: an accurate or invented statement, a promise phrased
// otherwise, an answer beside the point, the tone. It works in its own context: it sees neither the
// Comptoir's prompt nor its thinking, only Awa's documents, the message, the answer, the system's actions and
// the reference. It writes its finding before its verdict (the schema's order is respected, and a verdict
// given before the finding is wrong more often, chapter 12), and it is allowed “unknown” rather than
// inventing.
//
// A judge is checked before it is used: ch17/calibration.ts compares its verdicts with human grades. The
// rubrics are those of the Python version (python/ch17/rubrics/).

import type Anthropic from "@anthropic-ai/sdk";
import { join } from "node:path";
import { type MessagesClient, textOf } from "../comptoir/client.ts";
import { cost } from "../comptoir/costs.ts";
import { loadKnowledge } from "../comptoir/knowledge.ts";
import { logCall } from "../comptoir/log.ts";
import { SystemPrompt, loadData, renderCatalog, renderTerms } from "../comptoir/prompt.ts";
import { pythonJson } from "../comptoir/python.ts";
import { round } from "../comptoir/rounding.ts";
import { type EvaluationCase, type Trial, identifier } from "./harness.ts";
import { DATA, outcome, readText } from "./suite.ts";

export const CRITERIA = ["accurate", "no_promise", "answers", "tone"] as const;
export const RUBRIC = "v2"; // v1: without the tool results; v2: with them (see actions)
export const VERDICTS = ["yes", "no", "unknown"] as const;
export const MAX_TOKENS = 3000;

export const SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    CRITERIA.map((c) => [
      c,
      {
        type: "object",
        properties: { finding: { type: "string" }, verdict: { type: "string", enum: [...VERDICTS] } },
        required: ["finding", "verdict"],
        additionalProperties: false,
      },
    ]),
  ),
  required: [...CRITERIA],
  additionalProperties: false,
};

export function loadRubric(version = RUBRIC): SystemPrompt {
  return new SystemPrompt(readText(join(DATA, "rubrics", `judge_${version}.md`)).trim(), `judge-${version}`);
}

/** The same facts as the Comptoir's: catalog, terms and Awa's base. */
export function documents(): string {
  const data = loadData();
  const base = loadKnowledge().map((c) => `## ${c.title}\n${c.text}`).join("\n\n");
  return `<documents>\n<catalog>\n${renderCatalog(data)}\n</catalog>\n<terms>\n${renderTerms(data)}\n</terms>\n${base}\n</documents>`;
}

/** The first n characters, like text[:n] in Python (and not the first n UTF-16 units). */
const start = (text: string, n: number): string => [...text].slice(0, n).join("");

/** Each tool called, with what it answered: the result of a call arrives with the next call. */
export function toolsAndResults(trial: Pick<Trial, "calls">): string[] {
  const lines: string[] = [];
  trial.calls.forEach((call, rank) => {
    const requested = call.returned.filter((b) => b.type === "tool_use");
    const received = rank + 1 < trial.calls.length ? trial.calls[rank + 1]!.received : [];
    requested.forEach((block, i) => {
      const result = received[i];
      const answer = result === undefined ? "(no result)" : (result.error ? "ERROR: " : "") + start(result.content, 220);
      lines.push(`- ${block.name} ${start(pythonJson(block.input), 160)} → ${answer}`);
    });
  });
  return lines;
}

/**
 * What the system did, read in the shop and in the transcript: the judge checks the text against the facts.
 * Added after the first grading: without the tool results, the judge took for invented a stock that the
 * Comptoir had indeed checked.
 */
export function actions(trial: Trial): string {
  const pending = trial.summaries.filter((s) => s.status === "pending");
  const lines = [
    `summary prepared: ${pending.length ? `yes, total ${pending.at(-1)!.total} FCFA` : "no"}`,
    `requests passed on to Awa: ${trial.requests.length ? trial.requests.join(", ") : "none"}`,
    `orders created: ${trial.orders}`,
  ];
  const tools = toolsAndResults(trial);
  lines.push("tools called and their results:" + (tools.length ? "\n" + tools.join("\n") : " none"));
  return lines.join("\n");
}

export function request(c: EvaluationCase, trial: Trial, model: string, rubric: SystemPrompt | null = null): Anthropic.MessageCreateParamsNonStreaming {
  const r = rubric ?? loadRubric();
  const summary = trial.text.slice(trial.claude_text.length).trim() || "none";
  const toGrade =
    `<customer_message>\n${c.message}\n</customer_message>\n` +
    `<comptoir_answer>\n${trial.claude_text}\n</comptoir_answer>\n` +
    `<official_summary>\n${summary}\n</official_summary>\n` +
    `<system_actions>\n${actions(trial)}\n</system_actions>\n` +
    `<reference>\n${c.reference}\n</reference>`;
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: r.text,
    messages: [
      {
        role: "user",
        content: [
          // The documents do not change from one judgment to the next: they are read from the cache.
          { type: "text", text: documents(), cache_control: { type: "ephemeral" } },
          { type: "text", text: toGrade },
        ],
      },
    ],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
  };
}

export interface Judgment {
  trial: string; //            the ID of the trial judged
  model: string;
  rubric: string;
  verdicts: Record<string, string>;
  findings: Record<string, string>;
  cost_dollars: number;
  error: string | null;
}

/** “passed” if everything is yes, “failed” at the first no, otherwise “to_review”. */
export const outcomeOf = (j: Judgment): string => outcome(j);

export async function judge(client: MessagesClient, c: EvaluationCase, trial: Trial, model: string, rubric: SystemPrompt | null = null): Promise<Judgment> {
  const r = rubric ?? loadRubric();
  const message = await client.messages.create(request(c, trial, model, r));
  const price = cost(model, message.usage);
  logCall(message._request_id, model, price, { prompt: r.id, stop_reason: message.stop_reason });
  const judgment: Judgment = { trial: identifier(trial), model, rubric: r.id, verdicts: {}, findings: {}, cost_dollars: round(price.dollars, 6), error: null };
  if (message.stop_reason !== "end_turn") {
    judgment.error = `judgment stopped by ${message.stop_reason}`;
    return judgment;
  }
  const data = JSON.parse(textOf(message)) as Record<string, { finding: string; verdict: string }>;
  for (const k of CRITERIA) {
    judgment.verdicts[k] = data[k]!.verdict;
    judgment.findings[k] = data[k]!.finding;
  }
  return judgment;
}
