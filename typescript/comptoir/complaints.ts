// The complaints chain: extract, check, draft, evaluate, pass on (chapter 12).
//
// A fixed sequence, written in the code, where each call has a simple task:
// 1. extract the facts, with Claude Haiku 5.5 and a structured output;
// 2. check by code what is missing (the “gate” between two steps);
// 3. pass the record on to Awa, before everything else: if what follows fails, Awa has the complaint. No
//    complaint is settled without her;
// 4. draft the reply to the customer, with Claude Sonnet 5.5;
// 5. evaluate this reply: the code looks for the words that promise, Claude Haiku 5.5 reviews the rules; a
//    rejected reply is rewritten once, with the critique, then replaced by a fixed text if it fails again
//    (evaluator and optimizer).
//
// Each step can fail: an output cut off by max_tokens, an unreadable JSON. The code sees it and takes
// over; the complaint goes to Awa in every case. The drafting prompt is that of the Python version
// (python/comptoir/prompts/complaint_v1.md).

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type MessagesClient, textOf } from "./client.ts";
import { config } from "./config.ts";
import { cost } from "./costs.ts";
import { AFTER, BEFORE } from "./guard.ts";
import { PYTHON } from "./launch.ts";
import { logCall } from "./log.ts";
import { customerMessage, loadData } from "./prompt.ts";
import type { Shop } from "./shop.ts";
import { Trace } from "./trace.ts";

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

export const AUXILIARY_MODEL = config.AUXILIARY_MODEL; // extraction and evaluation (chapter 12)
export const REPLY_PROMPT = readFileSync(join(PYTHON, "comptoir", "prompts", "complaint_v1.md"), "utf8").replace(/\r\n?/g, "\n").trim();
export const PROBLEMS = ["damaged", "lukewarm", "wrong_item", "missing", "late", "rider", "health", "other"];

const NULLABLE = { anyOf: [{ type: "string" }, { type: "null" }] };
// The product comes from the catalog or is not known. In free text, the extraction wrote “bottles”, and
// the gate believed the product known: the human review saw it, not the tests.
export const PRODUCTS = loadData().products.map((p) => p.name);
const PRODUCT = { anyOf: [{ type: "string", enum: PRODUCTS }, { type: "null" }] };

export const FACTS_SCHEMA = {
  type: "object",
  properties: {
    problem: { type: "string", enum: PROBLEMS },
    product: PRODUCT,
    when: NULLABLE, //              as the customer writes it: “yesterday”, “this morning”
    customer_request: NULLABLE,
    urgent: { type: "boolean" }, //  health or safety: Awa is warned first
    summary: { type: "string" },
  },
  required: ["problem", "product", "when", "customer_request", "urgent", "summary"],
  additionalProperties: false,
};

// The critique first: the answer follows the order of the schema, and a box ticked before writing the
// opinion gets it wrong. Boxes first, a compliant reply was rejected 10 times out of 10; critique first, 0
// times out of 10, and a real promise stays rejected 10 times out of 10 (measured in chapter 12).
export const EVALUATION_SCHEMA = {
  type: "object",
  properties: {
    critique: { type: "string" },
    apologizes: { type: "boolean" },
    announces_pass_on_to_awa: { type: "boolean" },
    promises_something: { type: "boolean" },
    gives_medical_advice: { type: "boolean" },
  },
  required: ["critique", "apologizes", "announces_pass_on_to_awa", "promises_something", "gives_medical_advice"],
  additionalProperties: false,
};

export const EVALUATION_SYSTEM =
  "You review the reply of the Comptoir of Délices d'Awa to a customer who is complaining. You check four points, " +
  "without rewriting anything: the reply apologizes; it announces that the complaint is passed on to Awa; it promises " +
  "nothing (no refund, no replacement, no store credit, no gift, no delay other than 24 hours); it gives no " +
  "medical advice (inviting the customer to see a professional is allowed). The critique says in one sentence what " +
  "must be corrected, or “nothing”.";

// What the code refuses on its own, without asking a model. “credit” alone is not enough: “we do not
// accept credit cards” promises nothing. The word boundaries are Python's (BEFORE, AFTER), which follow
// accented letters.
export const PROMISES = new RegExp(
  `${BEFORE}refund|${BEFORE}replac(?:e|ed|ement)${AFTER}|${BEFORE}store credit${AFTER}|${BEFORE}credit note${AFTER}|` +
    `${BEFORE}for free${AFTER}|${BEFORE}free of charge${AFTER}|${BEFORE}on the house${AFTER}|${BEFORE}goodwill gesture${AFTER}|` +
    `${BEFORE}gift${AFTER}|${BEFORE}compensat`,
  "iu",
);

export const FALLBACK = "We are sorry for the inconvenience. Your complaint has been passed on to Awa, who will reply within 24 hours.";
export const HEALTH_FALLBACK = " If any discomfort persists, see a health professional.";

// Thinking included: at 400, 3 drafts out of 35 were cut off, one of them empty (measured in chapter 12).
export const DRAFTING_MAX_TOKENS = 1000;
export const DRAFTING_EFFORT = config.DRAFTING_EFFORT as Effort | null; // low: the measurement is in comptoir/config.py

export interface Facts {
  problem: string;
  product: string | null;
  when: string | null;
  customer_request: string | null;
  urgent: boolean;
  summary: string;
}

export const UNKNOWN_FACTS: Facts = {
  problem: "other",
  product: null,
  when: null,
  customer_request: null,
  urgent: false,
  summary: "Extraction impossible: the complaint is to be read in the conversation.",
};

export interface ComplaintResult {
  reply: string;
  facts: Facts;
  missing: string[];
  attempts: number;
  fallback: boolean;
  request: string | null; //  the ID of the request recorded for Awa
  critiques: string[];
  versions: string[]; //      each draft, kept for the review
}

/** null if the output is cut off or unreadable. The cost, though, is paid: it is returned anyway. */
async function structured(
  client: MessagesClient,
  model: string,
  system: string,
  content: string,
  schema: Record<string, unknown>,
  label: string,
): Promise<[Record<string, unknown> | null, number]> {
  const response = await client.messages.create({
    model,
    max_tokens: 600,
    system,
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema } },
  });
  const price = cost(model, response.usage);
  logCall(response._request_id, model, price, { prompt: label, stop_reason: response.stop_reason });
  if (response.stop_reason !== "end_turn") return [null, price.dollars];
  try {
    return [JSON.parse(textOf(response)) as Record<string, unknown>, price.dollars];
  } catch (error) {
    if (error instanceof SyntaxError) return [null, price.dollars];
    throw error;
  }
}

/**
 * The case of an enum value is not guaranteed (structured outputs documentation): “Ginger Juice”
 * becomes “Ginger juice” again.
 */
export function normalize(facts: Record<string, unknown>): Facts {
  const catalog = new Map(PRODUCTS.map((p) => [p.toLowerCase(), p]));
  const problem = String(facts.problem || "other").toLowerCase();
  const product = facts.product ? (catalog.get(String(facts.product).toLowerCase()) ?? null) : null;
  return { ...(facts as unknown as Facts), problem: PROBLEMS.includes(problem) ? problem : "other", product };
}

export async function extract(client: MessagesClient, message: string): Promise<[Facts, number]> {
  const system =
    "You read the complaint of a Délices d'Awa customer and extract its facts, without adding anything. " +
    "If a piece of information is not written, set null: product is the catalog product that the customer " +
    "names, or null if they do not name it. urgent is true only for a health or safety " +
    "problem. The summary fits in one neutral sentence, for Awa.";
  const [facts, price] = await structured(client, AUXILIARY_MODEL, system, customerMessage(message), FACTS_SCHEMA, "complaint-facts");
  // Without facts, the chain goes on: the gate will ask for everything, and Awa will read the conversation.
  return [facts ? normalize(facts) : { ...UNKNOWN_FACTS }, price];
}

/** The gate: what the code checks, without a model. */
export function missing(facts: Facts): string[] {
  const toAsk: string[] = [];
  if (!facts.product && facts.problem !== "late" && facts.problem !== "rider") toAsk.push("the product concerned");
  if (!facts.when) toAsk.push("the day of the delivery");
  return toAsk;
}

/** The text, its cost and the stop reason: a text stopped by max_tokens is incomplete. */
export async function draft(
  client: MessagesClient,
  message: string,
  toAsk: string[],
  critique: string | null = null,
  effort: Effort | null = DRAFTING_EFFORT,
): Promise<[string, number, string | null]> {
  const content =
    `${customerMessage(message)}\n\n<to_ask>${toAsk.join(", ")}</to_ask>` +
    (critique ? `\n\n<critique>Your previous reply was rejected: ${critique} Rewrite it.</critique>` : "");
  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model: config.MODEL,
    max_tokens: DRAFTING_MAX_TOKENS,
    system: REPLY_PROMPT,
    messages: [{ role: "user", content }],
  };
  if (effort) request.output_config = { effort };
  const response = await client.messages.create(request);
  const price = cost(config.MODEL, response.usage);
  logCall(response._request_id, config.MODEL, price, { prompt: "complaint-v1", stop_reason: response.stop_reason });
  return [textOf(response).trim(), price.dollars, response.stop_reason];
}

/** The problems of the reply; an empty list if it follows the rules. */
export async function evaluate(client: MessagesClient, reply: string): Promise<[string[], number]> {
  const promise = PROMISES.exec(reply);
  const problems = promise ? [`forbidden promise: “${promise[0]}”`] : [];
  const [judgment, price] = await structured(client, AUXILIARY_MODEL, EVALUATION_SYSTEM, `<answer>${reply}</answer>`, EVALUATION_SCHEMA, "complaint-evaluation");
  if (judgment === null) return [[...problems, "evaluation impossible"], price]; // a reply that was not reviewed is not sent
  if (!judgment.apologizes) problems.push("no apology");
  if (!judgment.announces_pass_on_to_awa) problems.push("passing on to Awa is not announced");
  if (judgment.promises_something) problems.push(`promise: ${judgment.critique}`);
  if (judgment.gives_medical_advice) problems.push(`medical advice: ${judgment.critique}`);
  return [problems, price];
}

export interface HandleOptions {
  trace?: Trace | null;
  maxAttempts?: number;
  effort?: Effort | null;
}

export async function handle(
  client: MessagesClient,
  message: string,
  shop: Shop,
  conversation: string,
  { trace = null, maxAttempts = 2, effort = DRAFTING_EFFORT }: HandleOptions = {},
): Promise<ComplaintResult> {
  const t = trace ?? new Trace();
  const facts = await t.step("extraction", AUXILIARY_MODEL, async (s) => {
    const [f, price] = await extract(client, message);
    s.record(price, `${f.problem}${f.urgent ? ", urgent" : ""}`);
    return f;
  });
  const toAsk = await t.step("check", "code", (s) => {
    const list = missing(facts);
    s.record(0, `to ask: ${list.length}`);
    return list;
  });
  const request = await t.step("pass_on", "code", (s) => {
    const reason = facts.urgent ? "urgent-complaint" : "complaint";
    const id = shop.passOn(conversation, reason, facts.summary).request;
    s.record(0, id);
    return id;
  });
  const critiques: string[] = [];
  const versions: string[] = [];
  let reply: string | null = null;
  let fallback = false;
  let toFix: string | null = null;
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt++;
    const [text, stop] = await t.step("drafting", config.MODEL, async (s) => {
      const [written, price, reason] = await draft(client, message, toAsk, toFix, effort);
      versions.push(written);
      s.record(price, `version ${attempt}` + (reason === "end_turn" ? "" : `, stopped by ${reason}`));
      return [written, reason] as const;
    });
    if (stop !== "end_turn") {
      // The code alone sees that a text is cut off: no need to pay the evaluator. We rewrite without a
      // critique: the text was not at fault, only incomplete.
      critiques.push(`answer stopped by ${stop}`);
      toFix = null;
      continue;
    }
    const problems = await t.step("evaluation", AUXILIARY_MODEL, async (s) => {
      const [list, price] = await evaluate(client, text);
      s.record(price, list.length ? `rejected (${list.length})` : "compliant");
      return list;
    });
    if (!problems.length) {
      reply = text;
      break;
    }
    toFix = problems.join("; ");
    critiques.push(toFix);
  }
  if (reply === null) {
    // The code has the last word: a fixed text, without promise, with the health advice if needed.
    reply = FALLBACK + (facts.urgent ? HEALTH_FALLBACK : "");
    fallback = true;
  }
  return { reply, facts, missing: toAsk, attempts: attempt, fallback, request, critiques, versions };
}
