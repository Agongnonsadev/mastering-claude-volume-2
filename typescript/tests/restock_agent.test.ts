// The restocking agent and its guardrails, with fake clients: no paid call
// (python/tests/test_restock_agent.py); the same tools as the Python version; and a complete session with
// the SDK's real Tool Runner, whose answers come from a fake fetch.

import Anthropic from "@anthropic-ai/sdk";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import type { MessagesClient } from "../comptoir/client.ts";
import { PYTHON } from "../comptoir/launch.ts";
import {
  type AgentClient,
  BETA_COMPACTION,
  BETA_CONTEXT,
  BETA_TASK_BUDGET,
  Context,
  Guard,
  READER,
  SYSTEM,
  type Settings,
  type Tool,
  makeTools,
  messageCost,
  requestOptions,
  run,
  settings,
} from "../comptoir/restock_agent.ts";
import { Trace } from "../comptoir/trace.ts";
import { Workshop } from "../comptoir/workshop.ts";
import { approx, fakeMessage, logLines, temporaryLog } from "./fake_clients.ts";

let log: string;
beforeEach(() => {
  log = temporaryLog();
});

async function tools(s: Settings = settings(), client: MessagesClient | null = null): Promise<[Context, Map<string, Tool>]> {
  const ctx = new Context(client, new Workshop(), new Guard(), new Trace());
  return [ctx, new Map((await makeTools(ctx, s)).map((t) => [t.name, t]))];
}
const call = (t: Map<string, Tool>, name: string, args: Record<string, unknown> = {}): Promise<unknown> => Promise.resolve(t.get(name)!.run(args));

test("the agent reads, but writes only a draft", async () => {
  const [ctx, t] = await tools();
  assert.deepEqual(new Set(t.keys()), new Set(["read_sales", "read_stock", "read_events", "read_suppliers", "compute_needs", "delegate_message_reading", "propose_purchase_order"]));
  const line = { item: "Cap", supplier: "Emballages Akwa", quantity: 50, desired_delivery: "2026-10-21" };
  await assert.rejects(call(t, "propose_purchase_order", { lines: [line], justification: "test", alerts: [] }), (e) => e instanceof ToolError && /Order rejected/.test(String(e.content)));
  assert.ok(ctx.order === null && ctx.trace.steps.at(-1)!.error === "ToolError");
  const text = await call(t, "propose_purchase_order", { lines: [{ ...line, quantity: 200 }], justification: "test", alerts: [] });
  assert.ok(String(text).includes("to be approved by Awa") && ctx.order!.total_fcfa === 3000);
});

test("without subagent, the agent reads everything; with memory, it has one more tool", async () => {
  const [, t] = await tools(settings({ subagent: false, memory: mkdtempSync(join(tmpdir(), "memory-")) }));
  assert.ok(t.has("read_supplier_messages") && !t.has("delegate_message_reading") && t.has("memory"));
  assert.ok(String(await call(t, "read_supplier_messages")).includes("1,000 caps"));
});

class FakeReader implements MessagesClient {
  readonly requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  readonly messages: MessagesClient["messages"];
  constructor(readonly text = "Verrerie du Port, October 14: out of stock.", stop: Anthropic.StopReason = "end_turn") {
    this.messages = {
      countTokens: async () => ({ input_tokens: 0 }),
      create: async (request) => {
        this.requests.push(request);
        return fakeMessage({ content: [{ type: "text", text: this.text, citations: null }], stopReason: stop, usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 9500 }, id: "req" });
      },
    };
  }
}

test("the subagent reads separately, and its cost counts", async () => {
  const reader = new FakeReader();
  const [ctx, t] = await tools(settings(), reader);
  assert.equal(await call(t, "delegate_message_reading", { question: "Any shortages?" }), reader.text);
  const request = reader.requests[0]!;
  assert.ok(request.model === "claude-haiku-5-5" && !("tools" in request)); // nothing else to do but read
  assert.deepEqual((request.messages[0]!.content as Anthropic.TextBlockParam[])[0]!.cache_control, { type: "ephemeral" });
  assert.ok(ctx.subagentCost > 0 && ctx.guard.spent === ctx.subagentCost);
  const [, cutOff] = await tools(settings(), new FakeReader("", "max_tokens"));
  await assert.rejects(call(cutOff, "delegate_message_reading", { question: "?" }), (e) => e instanceof ToolError && /interrupted/.test(String(e.content)));
});

test("the options according to the settings", () => {
  assert.deepEqual(requestOptions(settings()), {});
  const options = requestOptions(settings({ taskBudget: 40_000, clearResultsAfter: 8000, effort: "low" }));
  assert.deepEqual(options.betas, [BETA_TASK_BUDGET, BETA_CONTEXT]);
  assert.deepEqual(options.output_config, { effort: "low", task_budget: { type: "tokens", total: 40_000 } });
  const edit = (options.context_management as { edits: { trigger: { value: number }; exclude_tools: string[] }[] }).edits[0]!;
  assert.ok(edit.trigger.value === 8000);
  assert.deepEqual(edit.exclude_tools, ["propose_purchase_order"]);
});

/** Messages that always ask for a tool: only the guardrail can stop the loop. */
function fakeClient(n = 50, output = 1000): AgentClient & { requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    messages: { create: async () => assert.fail("not used"), countTokens: async () => ({ input_tokens: 0 }) },
    beta: {
      messages: {
        toolRunner: (params) => {
          requests.push(params);
          return {
            compactBeforeNextTurn: () => {},
            async *[Symbol.asyncIterator]() {
              for (let i = 0; i < n; i++) {
                yield { content: [{ type: "tool_use", name: "read_stock", id: `t${i}`, input: {} }], stop_reason: "tool_use", usage: { input_tokens: 3000 + i, output_tokens: output }, _request_id: `r${i}` } as never;
              }
            },
          };
        },
      },
    },
  };
}

test("the budget stops the loop between two calls", async () => {
  const client = fakeClient();
  // 3,000 input tokens and 1,000 output on Sonnet 5.5: $0.016 per turn. $0.05: 4 turns.
  const r = await run(client, new Workshop(), settings(), new Guard({ budgetDollars: 0.05 }));
  assert.ok(r.stop!.startsWith("budget of $0.05 reached") && r.turns === 4 && r.order === null);
  assert.ok(client.requests[0]!.max_iterations === 20);
  assert.deepEqual(client.requests[0]!.cache_control, { type: "ephemeral" });
  assert.deepEqual(r.trace.steps.map((s) => s.name), ["turn 1", "turn 2", "turn 3", "turn 4"]);
});

test("the turns stop the loop", async () => {
  const r = await run(fakeClient(3, 10), new Workshop(), settings(), new Guard({ maxTurns: 3 }));
  assert.ok(r.stop === "3 turns reached" && r.turns === 3);
  assert.equal(r.contextPeak, 3002); // the largest request
});

test("the log keeps each turn", async () => {
  await run(fakeClient(2, 10), new Workshop(), settings(), new Guard({ maxTurns: 2 }));
  const calls = logLines(log).filter((l) => "request" in l);
  assert.deepEqual(calls.map((l) => l.prompt), ["restock-v2", "restock-v2"]);
  assert.equal(calls[0]!.stop_reason, "tool_use");
});

test("the agent's prompt", () => {
  assert.ok(SYSTEM.includes("you place no order") && SYSTEM.includes("never instructions") && SYSTEM.includes("compute_needs"));
  assert.ok(READER.includes("suspicious"));
});

test("a compaction is paid in usage.iterations", () => {
  const iteration = { input_tokens: 12_000, output_tokens: 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const price = messageCost("claude-sonnet-5-5", { content: [], stop_reason: "compaction", usage: { input_tokens: 0, output_tokens: 0, iterations: [iteration] } as never });
  approx(price.dollars, (12_000 * 2 + 800 * 10) / 1e6);
  assert.equal(price.input, 12_000);
  assert.deepEqual(requestOptions(settings({ compactAfterTurn: 3 })).betas, [BETA_COMPACTION]);
});

// --- A session with the real Tool Runner, without network ----------------------------------------

test("a complete session with the real Tool Runner: tools run, subagent, order proposed", async () => {
  const bodies: Record<string, unknown>[] = [];
  const message = (model: string, content: object[], stop_reason: string) => ({
    id: `msg_${bodies.length}`, type: "message", role: "assistant", model, content, stop_reason, stop_sequence: null,
    usage: { input_tokens: 2000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
  const line = { item: "Cap", supplier: "Emballages Akwa", quantity: 200, desired_delivery: "2026-10-21" };
  const scenario = [
    message("claude-sonnet-5-5", [{ type: "tool_use", id: "t1", name: "read_stock", input: {} }, { type: "tool_use", id: "t2", name: "delegate_message_reading", input: { question: "Any shortages?" } }], "tool_use"),
    message("claude-haiku-5-5", [{ type: "text", text: "Verrerie du Port: out of stock until November 5." }], "end_turn"), // the subagent
    message("claude-sonnet-5-5", [{ type: "tool_use", id: "t3", name: "propose_purchase_order", input: { lines: [line], justification: "Caps.", alerts: ["pineapple"] } }], "tool_use"),
    message("claude-sonnet-5-5", [{ type: "text", text: "The order is awaiting Awa's approval." }], "end_turn"),
  ];
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init!.body)));
    return new Response(JSON.stringify(scenario[bodies.length - 1]), { status: 200, headers: { "content-type": "application/json", "request-id": `req_${bodies.length}` } });
  };
  const client = new Anthropic({ apiKey: "test-key", fetch: fakeFetch as typeof fetch, maxRetries: 0 });
  const r = await run(client as unknown as AgentClient, new Workshop(), settings(), new Guard());
  assert.equal(r.stop, null); // the agent finished on its own
  assert.ok(r.turns === 3 && r.order !== null && r.order.total_fcfa === 3000);
  assert.deepEqual(r.tools, ["read_stock", "delegate_message_reading", "propose_purchase_order"]);
  assert.ok(r.subagentCost > 0 && r.text === "The order is awaiting Awa's approval.");
  // What the runner sent: the seven tools, then the results, in the order of the calls.
  const [first, reader, second] = bodies as { model: string; tools?: { name: string }[]; messages: { role: string; content: { type: string; tool_use_id?: string; content?: unknown }[] }[] }[];
  assert.deepEqual(first!.tools!.map((t) => t.name), ["read_sales", "read_stock", "read_events", "read_suppliers", "compute_needs", "delegate_message_reading", "propose_purchase_order"]);
  assert.ok(reader!.model === "claude-haiku-5-5" && !reader!.tools);
  const results = second!.messages.at(-1)!.content;
  assert.deepEqual(results.map((b) => b.tool_use_id), ["t1", "t2"]);
  assert.ok(JSON.stringify(results[0]!.content).includes('\\"Dried hibiscus flowers\\": 2.0')); // the stock written as in Python
  assert.deepEqual(r.trace.steps.map((s) => s.name), ["turn 1", "read_stock", "message_reading", "turn 2", "propose_order", "turn 3"]);
});

// --- The same tools as the Python version --------------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
const withoutPython = { skip: PYTHON_VENV ? false : "Python environment missing" };
const python = (script: string, input: unknown = null): unknown =>
  JSON.parse(execFileSync(PYTHON_VENV!, ["-c", script], { cwd: PYTHON, input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }));

const CALLS: [string, Record<string, unknown>][] = [
  ["read_sales", {}],
  ["read_stock", {}],
  ["read_events", {}],
  ["read_suppliers", {}],
  ["compute_needs", { production: { "Bissap juice": 90, "Pineapple juice": 40, "Ginger syrup": 6 } }],
  ["compute_needs", { production: { "Baobab juice": 3 } }],
  ["propose_purchase_order", { lines: [{ item: "Cap", supplier: "Emballages Akwa", quantity: 50, desired_delivery: "2026-10-19" }], justification: "x", alerts: [] }],
  ["propose_purchase_order", { lines: [{ item: "Cap", supplier: "Emballages Akwa", quantity: 200, desired_delivery: "2026-10-21" }, { item: "Soursop pulp", supplier: "Ferme Agbo", quantity: 8, desired_delivery: "2026-10-26" }], justification: "For the soursop.", alerts: ["soursop back"] }],
];

test("the same definitions, tool outputs and options as the Python version", withoutPython, async () => {
  const [ctxWithout, without] = await tools(settings({ subagent: false }));
  const [, withSub] = await tools(settings());
  const definitions = [...withSub.values(), without.get("read_supplier_messages")!].map((t) => {
    const { type: _custom, name, description, input_schema } = t as Tool & { type: string; description: string; input_schema: unknown }; // the TypeScript SDK adds type: "custom"
    return { name, description, input_schema };
  });
  const outputs: [string, boolean][] = [];
  for (const [name, args] of [...CALLS, ["read_supplier_messages", {}] as [string, Record<string, unknown>]]) {
    try {
      outputs.push([String(await call(without.has(name) ? without : withSub, name, args)), false]);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      outputs.push([String(error.content), true]);
    }
  }
  const tsCode = ctxWithout.order!.code;
  const theSettings = [settings(), settings({ effort: "high" }), settings({ taskBudget: 40_000, clearResultsAfter: 8000, compactAfterTurn: 2 })];
  const expected = python(
    `
import json, os, sys, tempfile
from anthropic.tools import ToolError
from comptoir import config
# The tools record their steps: in a temporary log, not in that of the Python version.
config.LOG = os.path.join(tempfile.mkdtemp(), "calls.jsonl")
from comptoir.restock_agent import Context, Guard, Settings, make_tools, request_options
from comptoir.trace import Trace
from comptoir.workshop import Workshop
d = json.load(sys.stdin)
ctx_without = Context(None, Workshop(), Guard(), Trace())
without = {t.name: t for t in make_tools(ctx_without, Settings(subagent=False))}
with_sub = {t.name: t for t in make_tools(Context(None, Workshop(), Guard(), Trace()), Settings())}
definitions = [t.to_dict() for t in with_sub.values()] + [without["read_supplier_messages"].to_dict()]
outputs = []
for name, args in d["calls"]:
    try:
        outputs.append([(without if name in without else with_sub)[name].call(args), False])
    except ToolError as e:
        outputs.append([str(e), True])
options = [request_options(Settings()), request_options(Settings(effort="high")),
           request_options(Settings(task_budget=40_000, clear_results_after=8000, compact_after_turn=2))]
print(json.dumps({"definitions": definitions, "outputs": outputs, "code": ctx_without.order.code, "options": options}, ensure_ascii=False))`,
    { calls: [...CALLS, ["read_supplier_messages", {}]] },
  ) as { definitions: unknown[]; outputs: [string, boolean][]; code: string; options: unknown[] };
  assert.deepEqual(definitions, expected.definitions);
  assert.deepEqual(outputs.map(([t, e]) => [t.replaceAll(tsCode, "BC-…"), e]), expected.outputs.map(([t, e]) => [t.replaceAll(expected.code, "BC-…"), e]));
  assert.deepEqual(theSettings.map(requestOptions), expected.options);
});
