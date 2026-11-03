// The restocking agent: a framed agent loop (chapter 13).
//
// Claude reads the sales, the stock, the events, the sheets and the suppliers' messages, has the needs
// calculated by a tool, then proposes a purchase order. It chooses itself what it reads and in what order:
// it is an agent. The code frames it:
// - a number of turns, a budget in dollars and a timeout, checked between two calls;
// - optionally, a task budget (in beta), so that Claude adjusts its own effort;
// - a single tool that writes, and it writes only a draft: the order is checked by the code and stays “to
//   be approved by Awa”; nothing is sent;
// - a trace: each call and each tool, with its duration and its cost;
// - optionally: the reading of the messages entrusted to a subagent, a memory from one week to the next,
//   the clearing of old tool results.
//
// The prompts are those of the Python version (python/comptoir/prompts/restock_v2.md and reader_v1.md), and
// the tools have the same names, descriptions and schemas: Claude reads the same thing in both versions.

import type Anthropic from "@anthropic-ai/sdk";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { BetaLocalFilesystemMemoryTool, betaMemoryTool } from "@anthropic-ai/sdk/tools/memory/node";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type MessagesClient, textOf } from "./client.ts";
import { config } from "./config.ts";
import { Cost, cost } from "./costs.ts";
import { PYTHON } from "./launch.ts";
import { logCall } from "./log.ts";
import { pythonJson, splitWords, sum } from "./python.ts";
import { fixed, round } from "./rounding.ts";
import { Trace } from "./trace.ts";
import { InvalidOrder, InvalidValue, type Order, type Workshop, renderOrder } from "./workshop.ts";

const readPrompt = (name: string): string => readFileSync(join(PYTHON, "comptoir", "prompts", name), "utf8").replace(/\r\n?/g, "\n").trim();

export const SYSTEM = readPrompt("restock_v2.md");
export const READER = readPrompt("reader_v1.md");
export const INSTRUCTION = "It is Monday, October 19, 2026, 7 a.m. Prepare the week's draft purchase order.";
export const READER_MODEL = config.AUXILIARY_MODEL; // Claude Haiku 5.5: reading and summarizing, without tools

export const BETA_TASK_BUDGET = "task-budgets-2026-03-13";
export const BETA_CONTEXT = "context-management-2025-06-27";
export const BETA_COMPACTION = "compact-2026-09-04";

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

export interface Settings {
  model: string;
  effort: Effort | null;
  subagent: boolean; //                  the reading of the messages entrusted to Claude Haiku 5.5
  memory: string | null; //              a folder: the memory tool, from one week to the next
  taskBudget: number | null; //          in tokens, 20,000 at least (beta)
  clearResultsAfter: number | null; //   input tokens beyond which the old results are cleared
  compactAfterTurn: number | null; //    summarize the session after this turn (on-demand compaction, beta)
  maxTokens: number;
}

// Like the default values of a dataclass, the model is read once, when the module is loaded.
const DEFAULT_MODEL = config.MODEL;

export const settings = (s: Partial<Settings> = {}): Settings => ({
  model: DEFAULT_MODEL,
  effort: null,
  subagent: true,
  memory: null,
  taskBudget: null,
  clearResultsAfter: null,
  compactAfterTurn: null,
  maxTokens: 8000,
  ...s,
});

/** The limits that the code checks between two calls: we stop before paying for the next one. */
export class Guard {
  readonly maxTurns: number;
  readonly budgetDollars: number;
  readonly timeoutS: number;
  turns = 0;
  spent = 0;
  readonly start = performance.now();

  constructor({ maxTurns = 20, budgetDollars = 0.5, timeoutS = 300 } = {}) {
    this.maxTurns = maxTurns;
    this.budgetDollars = budgetDollars;
    this.timeoutS = timeoutS;
  }

  reasonToStop(): string | null {
    if (this.spent >= this.budgetDollars) return `budget of $${fixed(this.budgetDollars, 2)} reached ($${fixed(this.spent, 4)})`;
    if ((performance.now() - this.start) / 1000 >= this.timeoutS) return `timeout of ${fixed(this.timeoutS, 0)} s exceeded`;
    if (this.turns >= this.maxTurns) return `${this.maxTurns} turns reached`;
    return null;
  }
}

export interface Result {
  text: string;
  order: Order | null;
  stop: string | null; //   null: the agent finished on its own
  turns: number;
  spent: number;
  durationS: number;
  contextPeak: number; //   the largest request of the session, in input tokens
  tools: string[];
  subagentCost: number;
  clearings: unknown[];
  trace: Trace;
}

export class Context {
  order: Order | null = null;
  readonly tools: string[] = [];
  subagentCost = 0;

  constructor(
    readonly client: MessagesClient | null,
    readonly workshop: Workshop,
    readonly guard: Guard,
    readonly trace: Trace,
  ) {}
}

/**
 * The subagent: Claude Haiku 5.5, without tools, with the messages and a question. Its context is its own:
 * the main agent receives only the answer, not the thousands of words it took to read.
 */
export async function readBySubagent(client: MessagesClient, messages: string, question: string): Promise<[string, number]> {
  const response = await client.messages.create({
    model: READER_MODEL,
    max_tokens: 1000,
    thinking: { type: "disabled" },
    system: READER,
    messages: [
      {
        role: "user",
        content: [
          // The messages do not change from one question to the next: cached.
          { type: "text", text: `<messages>\n${messages}\n</messages>`, cache_control: { type: "ephemeral" } },
          { type: "text", text: `<question>${question}</question>` },
        ],
      },
    ],
  });
  const price = cost(READER_MODEL, response.usage);
  logCall(response._request_id, READER_MODEL, price, { prompt: "reader-v1", stop_reason: response.stop_reason });
  const text = textOf(response).trim();
  if (response.stop_reason !== "end_turn" || !text) {
    throw new ToolError(`Reading interrupted (stop: ${response.stop_reason ?? "None"}). Ask a more precise question.`);
  }
  return [text, price.dollars];
}

// The descriptions and the schemas that the Python SDK builds from the docstrings and the annotations
// (@beta_tool): the first line of the docstring, a blank line, then the rest.
const NO_ARGUMENT = { additionalProperties: false, properties: {}, type: "object" } as const;

export const DESCRIPTIONS = {
  read_sales:
    "Returns the usual sales of the last eight weeks, product by product and week by week,\n\n" +
    "their averages calculated by the code, and the past event orders set apart. To read in order to plan the\n" +
    "production of the next two weeks.",
  read_stock:
    "Returns this morning's stock: the finished products (bottles and flasks ready to sell) and the items\n\n" +
    "(ingredients and packaging), in the unit of their sheets.",
  read_events:
    "Returns the upcoming event orders, with their date, their bottles and their status: confirmed\n\n" +
    "(deposit paid) or a mere quote.",
  read_suppliers:
    "Returns the suppliers' sheets: for each item, who sells it, the usual delivery lead time in\n\n" +
    "days, the minimum order, the pack size and the unit price in FCFA. The sheets mention neither\n" +
    "shortages, nor exceptional delays, nor announced price increases: see the messages.",
  compute_needs:
    "Calculates, for a production of bottles and flasks, the items needed (ingredients and\n\n" +
    "packaging), the stock of each item, what is missing, and the quantity to order from each supplier\n" +
    "according to their sheets (minimum and pack size). Takes into account neither shortages nor lead times:\n" +
    "the choice of the supplier and the date is yours.",
  delegate_message_reading:
    "Entrusts the reading of the suppliers' WhatsApp messages (two months, several thousand words) to a\n\n" +
    "reading assistant, which answers your question in a few dated sentences. To use in order to know the\n" +
    "shortages, delays, exceptional lead times, price increases and new arrivals announced by the suppliers. A\n" +
    "precise question gets a precise answer; you can ask several.",
  read_supplier_messages:
    "Returns all the suppliers' WhatsApp messages of the last two months, from the oldest to the most recent\n\n" +
    "(several thousand words). They contain the shortages, delays, exceptional lead times, price increases and\n" +
    "new arrivals, which are not in the sheets.",
  propose_purchase_order:
    "Records the week's draft purchase order, to be approved by Awa. Nothing is sent to the\n\n" +
    "suppliers. The code checks each line against the sheets (does the supplier sell the item, minimum,\n" +
    "pack size, lead time) and Awa's ceiling, then calculates the amounts. If a rule is not respected,\n" +
    "the order is rejected with the list of errors: correct it and propose it again. A new order replaces\n" +
    "the previous one.",
};

export const NEEDS_SCHEMA = {
  additionalProperties: false,
  properties: {
    production: {
      additionalProperties: { type: "integer" },
      description:
        'The number of bottles or flasks to produce, per product, with the exact names of the\nproducts, for example {"Bissap juice": 90}. Subtract the finished products already in stock.',
      title: "Production",
      type: "object",
    },
  },
  required: ["production"],
  type: "object",
} as const;

export const QUESTION_SCHEMA = {
  additionalProperties: false,
  properties: {
    question: {
      description: 'What you want to know, for example: "Which suppliers announce a shortage or a delay?"',
      title: "Question",
      type: "string",
    },
  },
  required: ["question"],
  type: "object",
} as const;

export const ORDER_SCHEMA = {
  $defs: {
    OrderLine: {
      properties: {
        item: { title: "Item", type: "string" },
        supplier: { title: "Supplier", type: "string" },
        quantity: { title: "Quantity", type: "number" },
        desired_delivery: { title: "Desired Delivery", type: "string" },
      },
      required: ["item", "supplier", "quantity", "desired_delivery"],
      title: "OrderLine",
      type: "object",
    },
  },
  additionalProperties: false,
  properties: {
    lines: {
      description:
        "The lines of the order: the item and the supplier written exactly as in the sheets, the\nquantity in the unit of the sheet, and the desired delivery date in the format YYYY-MM-DD.",
      items: { $ref: "#/$defs/OrderLine" },
      title: "Lines",
      type: "array",
    },
    justification: {
      description: "For Awa, in a few sentences: the planned production, the choices of suppliers and dates.",
      title: "Justification",
      type: "string",
    },
    alerts: {
      description: "What Awa must know: shortages to expect, delays, price increases, suspicious messages,\nuncertainties. An empty list if there are none.",
      items: { type: "string" },
      title: "Alerts",
      type: "array",
    },
  },
  required: ["lines", "justification", "alerts"],
  type: "object",
} as const;

/** A Tool Runner tool: its definition (name, description, input_schema…) and its run function. */
export type Tool = BetaRunnableTool<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const wordCount = (text: string): number => splitWords(text).length; // len(text.split())

export async function makeTools(ctx: Context, s: Settings): Promise<Tool[]> {
  const workshop = ctx.workshop;
  /** A reading tool, without argument: the step of the trace, what it records, and what Claude reads. */
  const reading = (name: keyof typeof DESCRIPTIONS, step: string, result: (text: string) => string, read: () => string): Tool =>
    betaTool({
      name,
      description: DESCRIPTIONS[name],
      inputSchema: NO_ARGUMENT,
      run: () =>
        ctx.trace.step(step, "code", (r) => {
          ctx.tools.push(name);
          const text = read();
          r.record(0, result(text));
          return text;
        }),
    });

  const tools: Tool[] = [
    reading("read_sales", "read_sales", () => "8 weeks", () => workshop.salesSummary()),
    reading("read_stock", "read_stock", () => "morning stock", () => pythonJson(Object.fromEntries(Object.entries(workshop.stock()).filter(([k]) => k !== "_note")))),
    reading("read_events", "read_events", () => `${workshop.events().length} events`, () => pythonJson(workshop.events())),
    reading("read_suppliers", "read_suppliers", () => `${workshop.offers().length} offers`, () => pythonJson(workshop.offers())),
    betaTool({
      name: "compute_needs",
      description: DESCRIPTIONS.compute_needs,
      inputSchema: NEEDS_SCHEMA,
      run: ({ production }) =>
        ctx.trace.step("compute_needs", "code", (r) => {
          ctx.tools.push("compute_needs");
          let needs: Record<string, unknown>[];
          try {
            needs = workshop.needs(production as Record<string, number>);
          } catch (error) {
            if (error instanceof InvalidValue) throw new ToolError(error.message);
            throw error;
          }
          r.record(0, `${Object.values(production as Record<string, number>).reduce((a, b) => a + b, 0)} units to produce`);
          return pythonJson(needs);
        }),
    }),
    s.subagent
      ? betaTool({
          name: "delegate_message_reading",
          description: DESCRIPTIONS.delegate_message_reading,
          inputSchema: QUESTION_SCHEMA,
          run: ({ question }) =>
            ctx.trace.step("message_reading", READER_MODEL, async (r) => {
              ctx.tools.push("delegate_message_reading");
              if (!ctx.client) throw new Error("No client for the subagent.");
              const [answer, price] = await readBySubagent(ctx.client, workshop.supplierMessages(), String(question));
              ctx.guard.spent += price;
              ctx.subagentCost += price;
              r.record(price, `${wordCount(answer)} words`);
              return answer;
            }),
        })
      : reading("read_supplier_messages", "read_messages", (text) => `${wordCount(text)} words`, () => workshop.supplierMessages()),
    betaTool({
      name: "propose_purchase_order",
      description: DESCRIPTIONS.propose_purchase_order,
      inputSchema: ORDER_SCHEMA,
      run: ({ lines, justification, alerts }) =>
        ctx.trace.step("propose_order", "code", (r) => {
          ctx.tools.push("propose_purchase_order");
          let order: Order;
          try {
            order = workshop.propose((lines as Record<string, unknown>[]).map((l) => ({ ...l })), String(justification), alerts as string[]);
          } catch (error) {
            if (!(error instanceof InvalidOrder)) throw error;
            r.record(0, `rejected, ${error.errors.length} errors`);
            throw new ToolError("Order rejected: " + error.errors.join("; "));
          }
          if (ctx.order !== null) workshop.withdraw(ctx.order.code, order.code);
          ctx.order = order;
          r.record(0, `${order.code}, ${order.total_fcfa} FCFA`);
          return renderOrder(order) + "\nThe order is awaiting Awa's approval.";
        }),
    }),
  ];
  if (s.memory !== null) tools.push(betaMemoryTool(await BetaLocalFilesystemMemoryTool.init(s.memory)));
  return tools;
}

/** The options of the request according to the settings: task budget, effort, clearing of the results. */
export function requestOptions(s: Settings): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const betas: string[] = [];
  const output: Record<string, unknown> = {};
  if (s.effort) output.effort = s.effort;
  if (s.taskBudget) {
    betas.push(BETA_TASK_BUDGET);
    output.task_budget = { type: "tokens", total: s.taskBudget };
  }
  if (Object.keys(output).length) options.output_config = output;
  if (s.compactAfterTurn) betas.push(BETA_COMPACTION);
  if (s.clearResultsAfter) {
    betas.push(BETA_CONTEXT);
    options.context_management = {
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: s.clearResultsAfter },
          keep: { type: "tool_uses", value: 3 },
          exclude_tools: ["propose_purchase_order"], // the last state of the order stays visible
        },
      ],
    };
  }
  if (betas.length) options.betas = betas;
  return options;
}

type RunnerMessage = Pick<Anthropic.Beta.BetaMessage, "content" | "stop_reason" | "usage"> & {
  _request_id?: string | null;
  context_management?: { applied_edits?: unknown[] } | null;
};

/**
 * The cost of a message from the runner. A compaction has nothing in the top fields of usage: its cost is
 * in usage.iterations, which must be added up (compaction documentation).
 */
export function messageCost(model: string, message: RunnerMessage): Cost {
  const iterations = (message.usage as { iterations?: Parameters<typeof cost>[1][] | null }).iterations;
  if (message.stop_reason === "compaction" && iterations?.length) {
    const parts = iterations.map((i) => cost(model, i));
    const total = (field: (c: Cost) => number): number => parts.reduce((s, c) => s + field(c), 0);
    return new Cost(
      sum(parts.map((c) => c.dollars)),
      total((c) => c.input),
      total((c) => c.cacheWrite),
      total((c) => c.cacheRead),
      total((c) => c.output),
      total((c) => c.thinking),
      total((c) => c.searches),
    );
  }
  return cost(model, message.usage);
}

/** What the agent expects from the runner: messages, one per call, and compaction on demand. */
export interface Runner extends AsyncIterable<RunnerMessage> {
  compactBeforeNextTurn(): void;
}

/** What the agent expects from the client: the Tool Runner (and messages.create, for the subagent). */
export interface AgentClient extends MessagesClient {
  beta: { messages: { toolRunner(params: Record<string, unknown>): Runner } };
}

/** One session of the agent, from the first call to the proposed order, or until a limit. */
export async function run(client: AgentClient, workshop: Workshop, s: Settings = settings(), guard: Guard = new Guard()): Promise<Result> {
  const ctx = new Context(client, workshop, guard, new Trace());
  const runner = client.beta.messages.toolRunner({
    model: s.model,
    max_tokens: s.maxTokens,
    max_iterations: guard.maxTurns,
    system: SYSTEM,
    tools: await makeTools(ctx, s),
    messages: [{ role: "user", content: INSTRUCTION }],
    cache_control: { type: "ephemeral" }, // automatic caching: each turn rereads the previous one
    ...requestOptions(s),
  });

  let stop: string | null = null;
  let last: RunnerMessage | null = null;
  let peak = 0;
  const clearings: unknown[] = [];
  let instant = performance.now();
  let already = 0;
  for await (const message of runner) { // one message per call to Claude; the tools run between two messages
    guard.turns++;
    const price = messageCost(s.model, message);
    guard.spent += price.dollars;
    logCall(message._request_id ?? null, s.model, price, { prompt: "restock-v2", stop_reason: message.stop_reason });
    const u = message.usage;
    peak = Math.max(peak, (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0));
    const applied = message.context_management?.applied_edits;
    if (applied?.length) clearings.push(...applied);
    // The duration of the call: the elapsed time, minus that of the tools run in between (already traced).
    const now = performance.now();
    const toolsMs = ctx.trace.steps.slice(already).reduce((total, step) => total + step.durationMs, 0);
    const calls = message.content.filter((b) => b.type === "tool_use").map((b) => (b as { name: string }).name);
    ctx.trace.add(`turn ${guard.turns}`, s.model, Math.max(0, round(now - instant) - toolsMs), price.dollars, calls.join(", ") || String(message.stop_reason ?? "None"));
    instant = now;
    already = ctx.trace.steps.length;
    last = message;
    if (s.compactAfterTurn === guard.turns && message.stop_reason === "tool_use") {
      runner.compactBeforeNextTurn(); // after the tools of this turn, the history becomes a summary
    }
    if (message.stop_reason === "tool_use") {
      stop = guard.reasonToStop();
      if (stop) break; // none of this turn's tools is run: nothing is half done
    }
  }
  if (last !== null && last.stop_reason === "tool_use" && stop === null) {
    stop = `${guard.maxTurns} turns reached`; // the runner stopped on its own, at max_iterations
  }
  return {
    text: last ? textOf(last as unknown as Anthropic.Message).trim() : "",
    order: ctx.order,
    stop,
    turns: guard.turns,
    spent: guard.spent,
    durationS: (performance.now() - guard.start) / 1000,
    contextPeak: peak,
    tools: ctx.tools,
    subagentCost: ctx.subagentCost,
    clearings,
    trace: ctx.trace,
  };
}
