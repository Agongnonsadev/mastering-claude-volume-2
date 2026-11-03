// What the Comptoir uses of the SDK client. The real client (new Anthropic()) fits; so does a fake client
// of the tests, which answers without a paid call.

import type Anthropic from "@anthropic-ai/sdk";

/** A received message, with the request ID the SDK adds to it (to give to support). */
export type ReceivedMessage = Anthropic.Message & { _request_id?: string | null };

export interface MessagesClient {
  messages: {
    create(request: Anthropic.MessageCreateParamsNonStreaming): PromiseLike<ReceivedMessage>;
    countTokens(request: Anthropic.MessageCountTokensParams): PromiseLike<Anthropic.MessageTokensCount>;
  };
}

/** The text of an answer: only its text blocks (not the thinking, not the tools). */
export function textOf(message: Pick<Anthropic.Message, "content">): string {
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}
