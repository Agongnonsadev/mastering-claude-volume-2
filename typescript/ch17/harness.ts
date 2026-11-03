// The evaluation harness of chapter 17: one case, one variant, one trial, in a fresh environment.
//
// Each trial starts from zero: an in-memory shop with the stock of chapter 9, a stopped clock (a Tuesday at
// 10 a.m., Cotonou time), an empty budget, a new conversation. Nothing passes from one trial to the next: a
// trial that succeeds thanks to the previous one measures nothing.
//
// The API client is wrapped by a recorder: each call leaves in it the model, the stop, the tokens, the
// duration, the cost, what Claude wrote or requested, and the tool results it received. It is the transcript
// of the trial, to reread when a case fails.
//
// The messages of this set are test cases, not customers' messages: they can appear in the results, which
// the Comptoir's log, for its part, never does.
//
// A trial is written with the Python version's field names: a series of one is read by the other.

import type Anthropic from "@anthropic-ai/sdk";
import { Budget } from "../comptoir/budget.ts";
import type { MessagesClient, ReceivedMessage } from "../comptoir/client.ts";
import { cost } from "../comptoir/costs.ts";
import { randomId } from "../comptoir/database.ts";
import { ComptoirError } from "../comptoir/errors.ts";
import type { Chunk } from "../comptoir/knowledge.ts";
import { str, sum } from "../comptoir/python.ts";
import { PythonRandom } from "../comptoir/random.ts";
import { round } from "../comptoir/rounding.ts";
import { RoutedComptoir } from "../comptoir/routing.ts";
import { Shop } from "../comptoir/shop.ts";

export const TRIAL_TIME = new Date("2026-10-20T10:00:00+01:00"); // a Tuesday, before noon, in Cotonou
export const SUMMARY_START = "\n\nYour order summary";

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

/** A case of ch17/cases.json (python/ch17/cases.json, shared by both versions). */
export interface EvaluationCase {
  id: string;
  set: "improvement" | "verification";
  type: "common" | "trap" | "security";
  origin: string;
  message: string;
  category: string[];
  state?: { passed_on?: boolean; reason?: string[]; summary?: boolean; total?: number };
  reference: string;
  must_contain?: string[];
  one_of?: string[];
  must_not_contain?: string[];
  must_not_match?: string[];
  must_pass_on?: boolean;
  max_sentences?: number;
}

/**
 * What changes from one version of the Comptoir to another. The defaults are the version shipped in chapter
 * 17; since chapter 18, the shipped version has prompt v5 (suite.VARIANTS.shipped).
 */
export interface Variant {
  readonly name: string;
  readonly comptoir_model: string | null; //  null: the shipped version's, config.COMPTOIR_MODEL
  readonly prompt_version: string;
  readonly documents_version: string;
  readonly comptoir_effort: Effort | null; // chapter 19: null, the shipped version's effort
}

export const variant = (name: string, others: Partial<Omit<Variant, "name">> = {}): Variant =>
  Object.freeze({ name, comptoir_model: null, prompt_version: "v3", documents_version: "v1", comptoir_effort: null, ...others });

export interface ReturnedBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

export interface Call {
  model: string;
  stop: string | null;
  duration_s: number;
  cost_dollars: number;
  tokens: { input: number; cache_write: number; cache_read: number; output: number; thinking: number };
  received: { error: boolean; content: string }[];
  returned: ReturnedBlock[];
}

function blockSummary(block: Anthropic.ContentBlock): ReturnedBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_use") return { type: "tool_use", name: block.name, input: block.input };
  return { type: block.type }; // thinking: we note that it took place, not its content
}

/** The first 300 characters (and not UTF-16 units), like text[:300] in Python. */
const start = (text: string, n: number): string => [...text].slice(0, n).join("");

/** The tool results sent with this call: the shop's answer at the previous turn. */
function resultsReceived(request: Anthropic.MessageCreateParamsNonStreaming): Call["received"] {
  const last = request.messages.at(-1);
  if (!last || last.role !== "user" || typeof last.content === "string") return [];
  return last.content
    .filter((b): b is Anthropic.ToolResultBlockParam => typeof b === "object" && b !== null && b.type === "tool_result")
    .map((b) => ({ error: Boolean(b.is_error), content: start(str(b.content ?? null), 300) }));
}

/** Presents itself as the SDK's client (client.messages.create) and keeps a trace of each call. */
export class Recorder implements MessagesClient {
  readonly messages: MessagesClient["messages"] = this;
  readonly calls: Call[] = [];

  constructor(private readonly client: MessagesClient) {}

  countTokens(request: Anthropic.MessageCountTokensParams): PromiseLike<Anthropic.MessageTokensCount> {
    return this.client.messages.countTokens(request);
  }

  async create(request: Anthropic.MessageCreateParamsNonStreaming): Promise<ReceivedMessage> {
    const callStart = performance.now();
    const message = await this.client.messages.create(request);
    const price = cost(request.model, message.usage);
    this.calls.push({
      model: request.model,
      stop: message.stop_reason,
      duration_s: round((performance.now() - callStart) / 1000, 2),
      cost_dollars: round(price.dollars, 6),
      tokens: { input: price.input, cache_write: price.cacheWrite, cache_read: price.cacheRead, output: price.output, thinking: price.thinking },
      received: resultsReceived(request),
      returned: message.content.map(blockSummary),
    });
    return message;
  }
}

/** A step of the chapter 12 trace, with the Python version's names. */
export interface RecordedStep {
  name: string;
  model: string;
  duration_ms: number;
  cost_dollars: number;
  result: string;
  error: string | null;
}

export interface Trial {
  variant: string;
  case: string;
  trial: number;
  category: string;
  text: string; //                                     what the customer reads, summary included
  claude_text: string; //                              the part written by Claude, without the code's summary
  summaries: { status: string; total: number }[]; //   status and total, read in the shop
  requests: string[]; //                               reasons of the requests passed on to Awa
  orders: number;
  tools: string[];
  steps: RecordedStep[];
  calls: Call[];
  cost_dollars: number;
  latency_s: number;
  error: string | null;
}

export const TRIAL_FIELDS = [
  "variant", "case", "trial", "category", "text", "claude_text", "summaries", "requests", "orders",
  "tools", "steps", "calls", "cost_dollars", "latency_s", "error",
] as const satisfies readonly (keyof Trial)[];

/** Trial(variant, case, trial, …) in Python: the other fields have their default value. */
export const makeTrial = (variant: string, caseId: string, number: number, fields: Partial<Trial> = {}): Trial => ({
  variant, case: caseId, trial: number, category: "", text: "", claude_text: "", summaries: [], requests: [], orders: 0,
  tools: [], steps: [], calls: [], cost_dollars: 0, latency_s: 0, error: null, ...fields,
});

export const identifier = (t: Pick<Trial, "variant" | "case" | "trial">): string => `${t.variant}/${t.case}/${t.trial}`;

/** A fresh shop: stock of chapter 9, stopped clock, reproducible confirmation codes (the same as in Python). */
export function environment(seed = 17): Shop {
  const rng = new PythonRandom(seed);
  return new Shop(":memory:", { clock: () => TRIAL_TIME, rng: (n) => rng.randrange(n) });
}

export async function runTrial(client: MessagesClient, v: Variant, c: EvaluationCase, number: number, base: Chunk[]): Promise<Trial> {
  const recorder = new Recorder(client);
  const shop = environment();
  const conversation = randomId();
  const comptoir = new RoutedComptoir(recorder, shop, new Budget(":memory:"), conversation, base, {
    comptoirModel: v.comptoir_model, promptVersion: v.prompt_version, documentsVersion: v.documents_version, comptoirEffort: v.comptoir_effort,
  });
  const trial = makeTrial(v.name, c.id, number);
  const trialStart = performance.now();
  try {
    const reply = await comptoir.answer(c.message);
    trial.category = reply.category;
    trial.text = reply.text;
    trial.steps = reply.trace.steps.map((s) => ({
      name: s.name, model: s.model, duration_ms: s.durationMs, cost_dollars: s.costDollars, result: s.result, error: s.error,
    }));
  } catch (error) {
    if (error instanceof ComptoirError) {
      trial.error = `${error.diagnostic.code} (${error.diagnostic.origin})`;
    } else {
      // A failure of the harness or of the code: the trial fails, the series goes on.
      trial.error = error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
    }
  }
  trial.latency_s = round((performance.now() - trialStart) / 1000, 2);
  trial.claude_text = trial.text.split(SUMMARY_START)[0]!;
  trial.summaries = shop.summaries(conversation).map((s) => ({ status: s.status, total: Number(s.total) }));
  trial.requests = shop.requests().map((r) => r.reason);
  trial.orders = shop.orders().length;
  trial.calls = recorder.calls;
  trial.tools = recorder.calls.flatMap((c) => c.returned.filter((b) => b.type === "tool_use").map((b) => b.name!));
  trial.cost_dollars = round(sum(recorder.calls.map((c) => c.cost_dollars)), 6);
  return trial;
}
