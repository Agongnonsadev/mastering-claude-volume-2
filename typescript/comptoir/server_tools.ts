// The tools Anthropic runs for you: web search, page reading, code execution (chapter 10).
//
// You declare them in the request; the API runs them during the request and puts their results in the
// response. Your code runs nothing, but it reads everything: the sources cited, the errors (which arrive in
// a 200 response), the files produced, the cost.

import type Anthropic from "@anthropic-ai/sdk";
import { type MessagesClient, type ReceivedMessage, textOf } from "./client.ts";
import { cost } from "./costs.ts";
import { logCall } from "./log.ts";

// Searches start from Cotonou: local results come first. Without the country: on October 20, 2026, the
// API rejected the code “BJ” (“Country code BJ is not supported”, 400).
export const COTONOU_LOCATION: Anthropic.UserLocation = { type: "approximate", city: "Cotonou", timezone: "Africa/Porto-Novo" };

/**
 * Dynamic filtering (versions 20260209 and later) has code sort the results before they enter the
 * context: fewer tokens, but no more ZDR by default.
 */
export function webSearch(maxUses = 3, domains: string[] | null = null, dynamicFiltering = false): Anthropic.ToolUnion {
  const tool = {
    type: dynamicFiltering ? ("web_search_20260209" as const) : ("web_search_20250305" as const),
    name: "web_search" as const,
    max_uses: maxUses,
    user_location: COTONOU_LOCATION,
    ...(domains?.length ? { allowed_domains: domains } : {}),
  };
  return tool;
}

/** maxContentTokens bounds what a page costs: an average page already weighs 2,500 tokens. */
export function webFetch(maxUses = 2, maxContentTokens = 8000, citations = true, domains: string[] | null = null): Anthropic.WebFetchTool20250910 {
  return {
    type: "web_fetch_20250910",
    name: "web_fetch",
    max_uses: maxUses,
    max_content_tokens: maxContentTokens,
    citations: { enabled: citations },
    ...(domains?.length ? { allowed_domains: domains } : {}),
  };
}

export const CODE_EXECUTION: Anthropic.CodeExecutionTool20250825 = { type: "code_execution_20250825", name: "code_execution" };

export interface Result {
  message: ReceivedMessage; // the last message
  text: string;
  cost: number; //            in dollars, all the calls of the request, searches included
  calls: number;
  searches: number;
  resumptions: number; //     number of pause_turn handled
  messages: ReceivedMessage[];
}

/**
 * A call with server tools, resuming the pauses (pause_turn) up to maxResumptions times.
 *
 * A pause is not an error: the server-side tool loop paused. We send the response back as is, with the
 * same tools, and Claude continues.
 */
export async function call(
  client: MessagesClient,
  request: Anthropic.MessageCreateParamsNonStreaming,
  maxResumptions = 3,
  prompt: string | null = null,
): Promise<Result> {
  let messages = [...request.messages];
  let total = 0;
  let searches = 0;
  const received: ReceivedMessage[] = [];
  for (let resumption = 0; resumption <= maxResumptions; resumption++) {
    const message = await client.messages.create({ ...request, messages });
    const price = cost(request.model, message.usage);
    logCall(message._request_id, request.model, price, { prompt, stop_reason: message.stop_reason });
    total += price.dollars;
    searches += price.searches;
    received.push(message);
    if (message.stop_reason !== "pause_turn") {
      return { message, text: textOf(message), cost: total, calls: received.length, searches, resumptions: resumption, messages: received };
    }
    messages = [...messages, { role: "assistant", content: message.content as Anthropic.ContentBlockParam[] }];
  }
  throw new Error(`Still paused after ${maxResumptions} resumptions: run it again later or lower max_uses.`);
}

/** The text of the response. With citations, it arrives in several blocks, to be joined. */
export const text = (message: Pick<Anthropic.Message, "content">): string => textOf(message);

type Block = { type: string; citations?: unknown[] | null; content?: unknown };
type Citation = { url?: string | null; title?: string | null; document_title?: string | null };

/** The sources cited, without duplicates, in order of appearance. To show the reader. */
export function sources(message: { content: unknown[] }): { source: string; title: string | null }[] {
  const seen = new Set<string>();
  const found: { source: string; title: string | null }[] = [];
  for (const block of message.content as Block[]) {
    for (const citation of (block.citations ?? []) as Citation[]) {
      const key = citation.url || citation.document_title;
      if (key && !seen.has(key)) {
        seen.add(key);
        found.push({ source: key, title: citation.title || citation.document_title || null });
      }
    }
  }
  return found;
}

/** The errors of the server tools. They interrupt nothing: they arrive in a 200 response. */
export function toolErrors(message: { content: unknown[] }): string[] {
  return (message.content as Block[])
    .filter((b) => b.type.endsWith("_tool_result"))
    .flatMap((b) => {
      const code = (b.content as { error_code?: string } | undefined)?.error_code;
      return code ? [`${b.type}: ${code}`] : [];
    });
}

/** The IDs of the files created by code execution, to download through the Files API. */
export function producedFiles(message: { content: unknown[] }): string[] {
  return (message.content as Block[])
    .filter((b) => b.type === "bash_code_execution_tool_result")
    .flatMap((b) => {
      const result = b.content as { type?: string; content?: { file_id?: string }[] };
      return result?.type === "bash_code_execution_result" ? (result.content ?? []).flatMap((s) => (s.file_id ? [s.file_id] : [])) : [];
    });
}
