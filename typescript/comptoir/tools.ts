// The Comptoir's tools: what Claude can ask for, and what the code really does (chapter 9).
//
// Only three tools, each with a description that says what, when, and what it does not do. Strict mode
// guarantees parameters that conform to the schema; the rules the schema cannot carry (a quantity of at
// least 1, a catalog product) are checked by the shop, which answers with an explicit error.
//
// No tool creates an order: it is the customer who confirms, with a code that the code checks
// (comptoir/orders.ts).

import type Anthropic from "@anthropic-ai/sdk";
import { pythonJson } from "./python.ts";
import { type RequestedLine, type Shop, ShopRefusal, type Summary } from "./shop.ts";

/** A strict schema object: all the fields declared, no extra field. */
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "stock_check",
    description:
      "Gives the quantity available today for one or more products in the Délices d'Awa catalog. " +
      "Use it when a customer wants to order, or asks whether a product is available. " +
      "The names must be those of the catalog, exactly, for example “Bissap juice”. " +
      "Returns neither prices nor delivery times: prices are in the catalog, delivery times in the terms.",
    strict: true,
    input_schema: object(
      { products: { type: "array", items: { type: "string" }, description: "The exact names of the catalog products to check." } },
      ["products"],
    ),
  },
  {
    name: "order_prepare",
    description:
      "Prepares the official summary of an order: checks the products and the stock, calculates the total " +
      "with the catalog prices and the delivery fee. Does not create the order: it exists only after " +
      "the customer's confirmation, which the system collects itself with a code. " +
      "Call it when the customer has said what they want, under what name and to which Cotonou neighborhood to deliver it. " +
      "If the customer changes their mind, call the tool again with the new order: the previous summary " +
      "is canceled. If the tool returns an error (unknown product, insufficient stock, quote needed), " +
      "explain it to the customer and offer a solution.",
    strict: true,
    input_schema: object(
      {
        lines: {
          type: "array",
          description: "The products ordered, one line per product.",
          items: object(
            {
              product: { type: "string", description: "The exact catalog name." },
              quantity: { type: "integer", description: "The number of bottles, at least 1." },
            },
            ["product", "quantity"],
          ),
        },
        customer_name: { type: "string", description: "The name given by the customer for the delivery." },
        neighborhood: { type: "string", description: "The delivery neighborhood, in Cotonou." },
      },
      ["lines", "customer_name", "neighborhood"],
    ),
  },
  {
    name: "pass_to_awa",
    description:
      "Passes on to Awa a request only she can handle: discount or special price, complaint, quote " +
      "(event, or more than 50 bottles), delivery outside Cotonou, or a question with no answer in the " +
      "catalog and the terms. Awa reads these requests several times a day and answers the customer herself. " +
      "After the call, tell the customer that their request has been passed on; promise neither a result, nor any delay " +
      "other than those in the terms.",
    strict: true,
    input_schema: object(
      {
        reason: { type: "string", enum: ["discount", "complaint", "quote", "out_of_zone", "other"] },
        summary: { type: "string", description: "The request in one or two sentences, so that Awa understands it without rereading the conversation." },
      },
      ["reason", "summary"],
    ),
  },
];

export const NAMES = new Set(TOOLS.map((t) => t.name));

/**
 * JSON written like Python's json.dumps (“,” and “:” followed by a space): a tool result is the same
 * text, hence the same number of tokens, in both versions of the Comptoir.
 */
export const toJson = (value: unknown): string => pythonJson(value);

/** What a tool turn produced, on top of the results sent back to Claude. */
export class Execution {
  summary: Summary | null = null;
  readonly passedOn: { request: string; passed_on: true }[] = [];
  readonly calls: string[] = [];
}

/** Runs the tools for a given conversation, on a given shop. */
export class Tools {
  constructor(
    readonly shop: Shop,
    readonly conversation: string,
  ) {}

  /** A tool_use block in, a tool_result block out. Never an exception toward the loop. */
  execute(call: Pick<Anthropic.ToolUseBlock, "id" | "name" | "input">, execution: Execution): Anthropic.ToolResultBlockParam {
    execution.calls.push(call.name);
    try {
      const result = this.executeTool(call.name, call.input as Record<string, unknown>, execution);
      return { type: "tool_result", tool_use_id: call.id, content: toJson(result) };
    } catch (refusal) {
      if (!(refusal instanceof ShopRefusal)) throw refusal;
      // An instructive error: what is wrong, and what Claude must do now.
      return { type: "tool_result", tool_use_id: call.id, content: refusal.message, is_error: true };
    }
  }

  private executeTool(name: string, input: Record<string, unknown>, execution: Execution): unknown {
    if (name === "stock_check") {
      return Object.fromEntries(
        (input.products as string[]).map((p) => [p, this.shop.catalog.has(p) ? this.shop.available(p) : "missing from the catalog"]),
      );
    }
    if (name === "order_prepare") {
      const summary = this.shop.prepare(this.conversation, input.lines as RequestedLine[], String(input.customer_name), String(input.neighborhood));
      execution.summary = summary;
      // Claude does not receive the code: the system itself shows the official summary.
      const { confirmation_code: _code, to_tell_the_customer: _sentence, ...forClaude } = summary;
      return forClaude;
    }
    if (name === "pass_to_awa") {
      const request = this.shop.passOn(this.conversation, String(input.reason), String(input.summary));
      execution.passedOn.push(request);
      return request;
    }
    throw new ShopRefusal(`Unknown tool “${name}”. Available tools: ${[...NAMES].sort().join(", ")}.`);
  }
}
