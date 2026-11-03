// Answering from Awa's documents, with the sources (chapter 11).
//
// Two ways to give Claude the documents, with the same request and the same citations:
// - the whole base, cached: the start of the request never changes, it is read from the cache at every
//   question;
// - only the chunks found by a retrieval (RAG): fewer tokens, but a start of the request that changes at
//   every question, so nothing to cache.
//
// The chunks are search_result blocks: each citation comes back with our ID (kb://faq#…), which the code
// can check and display. The prompts are those of the Python version
// (python/comptoir/prompts/doc_assistant_vN.md).

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type MessagesClient, textOf } from "./client.ts";
import { config } from "./config.ts";
import { type Cost, cost } from "./costs.ts";
import { type Cache, type Chunk, resultBlocks } from "./knowledge.ts";
import { PYTHON } from "./launch.ts";
import { logCall } from "./log.ts";
import { normalize } from "./notation.ts";
import { SystemPrompt, customerMessage } from "./prompt.ts";
import { round } from "./rounding.ts";

const PROMPTS_FOLDER = join(PYTHON, "comptoir", "prompts");
export const MAX_TOKENS = 1000;

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

export function loadPrompt(version = "v1"): SystemPrompt {
  const text = readFileSync(join(PROMPTS_FOLDER, `doc_assistant_${version}.md`), "utf8").replace(/\r\n/g, "\n").trim();
  return new SystemPrompt(text, `doc_assistant-${version}`);
}

export interface RequestOptions {
  prompt?: SystemPrompt | null;
  cache?: Cache;
  model?: string | null;
  /** Chapter 12: for Claude Haiku 5.5, which accepts not to think. */
  noThinking?: boolean;
  maxTokens?: number;
  withCitations?: boolean;
}

/**
 * The documents first, the question at the end: it is the order Anthropic recommends for long documents,
 * and the only one that allows caching (the start does not vary).
 */
export function buildRequest(question: string, chunks: Chunk[], options: RequestOptions = {}): Anthropic.MessageCreateParamsNonStreaming {
  const { cache = true, model = null, noThinking = false, maxTokens = MAX_TOKENS, withCitations = true } = options;
  const prompt = options.prompt ?? loadPrompt();
  const content: Anthropic.ContentBlockParam[] = [...resultBlocks(chunks, cache, withCitations), { type: "text", text: customerMessage(question) }];
  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model: model || config.MODEL,
    max_tokens: maxTokens,
    system: prompt.text,
    messages: [{ role: "user", content }],
  };
  // The effort chosen in chapter 3 applies to the Comptoir's model.
  if (config.EFFORT && !model) request.output_config = { effort: config.EFFORT as Effort };
  if (noThinking) request.thinking = { type: "disabled" };
  return request;
}

export interface Citation {
  source: string; // kb://faq#…
  title: string;
  text: string; //   the cited passage, as it is in the document
}

export interface DocAnswer {
  text: string;
  citations: Citation[];
  cost: Cost;
  latencyS: number;
  requestId: string | null;
  sources: string[]; //  the cited IDs, without duplicates
  plainText: string; //  the same text, without references: for a customer on WhatsApp
  stop: string; //       the stop reason: a cut-off answer is not an answer (chapter 8)
}

type Block = { type: string; text?: string; citations?: { type?: string; source?: string; title?: string | null; cited_text?: string }[] | null };

/** The citations of the base's passages (search_result_location), without duplicates. */
export function citations(message: { content: unknown[] }): Citation[] {
  const seen = new Set<string>();
  const result: Citation[] = [];
  for (const block of message.content as Block[]) {
    if (block.type !== "text") continue;
    for (const c of block.citations ?? []) {
      if (c.type !== "search_result_location") continue;
      const key = JSON.stringify([c.source, c.cited_text]);
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ source: c.source!, title: c.title || "", text: c.cited_text! });
      }
    }
  }
  return result;
}

/** The text of the answer, with a reference [1], [2]… after each cited passage. */
export function textWithReferences(message: { content: unknown[] }): string {
  const numbers = new Map<string, number>();
  const pieces: string[] = [];
  for (const block of message.content as Block[]) {
    if (block.type !== "text") continue;
    pieces.push(block.text ?? "");
    const sources = [...new Set((block.citations ?? []).filter((c) => c.type === "search_result_location").map((c) => c.source!))];
    for (const s of sources) if (!numbers.has(s)) numbers.set(s, numbers.size + 1);
    pieces.push(sources.map((s) => `[${numbers.get(s)}]`).join(""));
  }
  return pieces.join("").trim();
}

/** A test question, written before the trials (chapter 3). The fields are those of ch11/questions.json. */
export interface DocCase {
  id: string;
  question: string;
  sources: string[]; //  at least one must be cited
  one_of: string[]; //   at least one of these facts in the answer
  absent: boolean; //    the answer is not in the documents
  refer: boolean; //     health question: refer to a professional
  to_review: string;
}

const CASE_FIELDS = ["id", "question", "sources", "one_of", "absent", "refer", "to_review"];

/** A case completed with its default values. An unknown field is refused, as in Python (cls(**d)). */
export function makeDocCase(d: Pick<DocCase, "id" | "question"> & Partial<DocCase>): DocCase {
  const unknown = Object.keys(d).filter((key) => !CASE_FIELDS.includes(key));
  if (unknown.length) throw new TypeError(`Unknown field in a case: ${unknown.join(", ")}`);
  return { sources: [], one_of: [], absent: false, refer: false, to_review: "", ...d };
}

// The ways of saying "I don't know" that the code recognizes. Any other wording will be counted as a
// failure, then reviewed: the grid is corrected in writing, never on the sly.
export const DONT_KNOW = new RegExp(
  "can't find|cannot find|can not find|couldn't find|could not find|doesn't appear|does not appear|" +
    "no information|don't have this information|do not have this information|don't have that information|" +
    "I don't know|don't specify|do not specify|don't mention|do not mention|don't say|do not say|" +
    "je ne trouve pas|ne figure pas|pas d'information|aucune information|pas cette information",
  "iu",
);

/** The reasons for the failure; an empty list if the answer passes the code's criteria. */
export function scoreDocAnswer(c: DocCase, answer: Pick<DocAnswer, "text" | "sources" | "stop">, requireSources = true): string[] {
  const text = normalize(answer.text);
  const reasons: string[] = [];
  if (answer.stop !== "end_turn") reasons.push(`answer stopped by ${answer.stop}`);
  if (c.absent) {
    if (!DONT_KNOW.test(answer.text)) reasons.push("does not say the information is missing");
    if (!text.includes("awa")) reasons.push("does not offer to pass it on to Awa");
    return reasons;
  }
  if (requireSources && !c.sources.some((s) => answer.sources.includes(s))) reasons.push("none of the expected sources is cited");
  if (c.one_of.length && !c.one_of.some((f) => text.includes(normalize(f)))) reasons.push(`none of: ${c.one_of.join(", ")}`);
  if (c.refer && !["professional", "doctor", "professionnel", "médecin", "medecin"].some((w) => text.includes(w))) {
    reasons.push("does not refer to a health professional");
  }
  return reasons;
}

export interface AnswerOptions extends RequestOptions {
  mode?: string; // for the log: context, rag, rag-reranked
}

export async function answer(client: MessagesClient, question: string, chunks: Chunk[], options: AnswerOptions = {}): Promise<DocAnswer> {
  const prompt = options.prompt ?? loadPrompt();
  const request = buildRequest(question, chunks, { ...options, prompt });
  const start = performance.now();
  const message = await client.messages.create(request);
  const latency = (performance.now() - start) / 1000;
  const price = cost(request.model, message.usage);
  logCall(message._request_id, request.model, price, { prompt: prompt.id, mode: options.mode ?? "context", stop_reason: message.stop_reason });
  const cited = citations(message);
  return {
    text: textWithReferences(message),
    citations: cited,
    cost: price,
    latencyS: round(latency, 2),
    requestId: message._request_id ?? null,
    sources: [...new Set(cited.map((c) => c.source))],
    plainText: textOf(message).trim(),
    stop: message.stop_reason ?? "None",
  };
}
