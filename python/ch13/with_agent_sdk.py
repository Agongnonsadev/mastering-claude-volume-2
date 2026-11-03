"""Chapter 13: the same agent, built with the Claude Agent SDK, Claude Code's engine as a library.

- the workshop's tools, the same functions as with the Tool Runner, become an MCP server
  that runs in this process;
- no built-in tool of Claude Code, except Agent, which entrusts a task to a subagent;
- a “reader” subagent, on Claude Haiku 5.5, is the only one that can read the suppliers'
  messages: a PreToolUse hook checks it at each call, through the code;
- a PostToolUse hook records each action in the log;
- none of the user's settings is loaded (setting_sources=[]), Claude Code's configuration is
  fresh (CLAUDE_CONFIG_DIR), and the agent works in an empty folder.

Run, from the python/ folder:  python -m ch13.with_agent_sdk --max-budget 0.60
"""

import argparse
import asyncio
import tempfile
import time
from pathlib import Path

from anthropic.tools import ToolError
from claude_agent_sdk import (AgentDefinition, AssistantMessage, ClaudeAgentOptions, HookMatcher, ResultMessage,
                              create_sdk_mcp_server, query, tool)

from ch13.criteria import criteria
from comptoir import config
from comptoir.log import log_event
from comptoir.restock_agent import INSTRUCTION, READER, SYSTEM, Context, Guard, Settings, make_tools
from comptoir.trace import Trace
from comptoir.workshop import Workshop, render_order

SERVER = "workshop"
READING = f"mcp__{SERVER}__read_supplier_messages"


def workshop_server(ctx: Context):
    """The Tool Runner's tools, wrapped for the SDK: same name, same description, same schema."""
    tools = []
    for t in make_tools(ctx, Settings(subagent=False)):  # direct reading: it is the subagent that reads
        def wrap(o):
            @tool(o.name, o.description, o.input_schema)
            async def call(arguments: dict) -> dict:
                try:
                    return {"content": [{"type": "text", "text": o.call(arguments)}]}
                except ToolError as error:
                    return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
            return call
        tools.append(wrap(t))
    return create_sdk_mcp_server(name=SERVER, version="1.0.0", tools=tools)


async def guard(hook_input: dict, tool_use_id, context) -> dict:
    """PreToolUse: the rule is in the code, not in the prompt. Subagents have an agent_id."""
    name = hook_input["tool_name"]
    refusal = None
    if name != "Agent" and not name.startswith(f"mcp__{SERVER}__"):
        refusal = "only the workshop's tools are allowed"
    elif name == READING and not hook_input.get("agent_id"):
        refusal = "reading the messages is reserved for the reader subagent: hand it your question"
    if refusal:
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason": refusal}}
    return {}


async def log_action(hook_input: dict, tool_use_id, context) -> dict:
    """PostToolUse: the log of actions, without the data (only who did what)."""
    log_event("action", tool=hook_input["tool_name"], by=hook_input.get("agent_type") or "main agent")
    return {}


def options(ctx: Context, max_budget: float, folder: str) -> ClaudeAgentOptions:
    workshop_tools = [f"mcp__{SERVER}__{name}" for name in ("read_sales", "read_stock", "read_events",
                                                           "read_suppliers", "compute_needs",
                                                           "read_supplier_messages", "propose_purchase_order")]
    return ClaudeAgentOptions(
        model=config.MODEL,
        system_prompt=SYSTEM + "\n\nTo know the suppliers' messages, hand your question to the “reader” "
                               "subagent, with the Agent tool.",
        mcp_servers={SERVER: workshop_server(ctx)},
        tools=["Agent"],                      # no built-in tool, except delegating to a subagent
        allowed_tools=["Agent", *workshop_tools],
        permission_mode="dontAsk",            # what is not allowed is refused, without a question
        agents={"reader": AgentDefinition(
            description="Reads the suppliers' WhatsApp messages and answers a precise question, citing the "
                        "dates and the suppliers.",
            prompt=READER + "\n\nRead the messages with the read_supplier_messages tool.",
            tools=[READING], model=config.AUXILIARY_MODEL)},
        hooks={"PreToolUse": [HookMatcher(hooks=[guard])], "PostToolUse": [HookMatcher(hooks=[log_action])]},
        max_turns=20,
        max_budget_usd=max_budget,            # an estimate on the client side, which can be slightly exceeded
        setting_sources=[],                   # neither your settings, nor your CLAUDE.md, nor your Skills
        cwd=folder,
        env={"CLAUDE_CONFIG_DIR": str(Path(folder) / ".config")},
    )


async def run_with_the_sdk(max_budget: float) -> tuple[ResultMessage | None, Context, list[str]]:
    ctx = Context(None, Workshop(), Guard(), Trace())
    calls: list[str] = []
    with tempfile.TemporaryDirectory() as folder:
        result = None
        async for message in query(prompt=INSTRUCTION, options=options(ctx, max_budget, folder)):
            if isinstance(message, AssistantMessage):
                calls += [b.name for b in message.content if type(b).__name__ == "ToolUseBlock"]
            elif isinstance(message, ResultMessage):
                result = message
    return result, ctx, calls


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--max-budget", type=float, default=0.60)
    args = parser.parse_args()
    start = time.perf_counter()
    result, ctx, calls = asyncio.run(run_with_the_sdk(args.max_budget))
    print(f"Tool calls of the main agent: {calls}")
    print(ctx.trace.show())
    if result:
        print(f"\nEnd: {result.subtype}; {result.num_turns} turns; ${result.total_cost_usd} "
              f"(SDK's estimate); {result.duration_ms / 1000:.1f} s")
        print(f"Cost per model: {getattr(result, 'model_usage', None)}")
        print("\nThe agent's summary:\n" + (result.result or ""))
    print(f"\nTotal duration: {time.perf_counter() - start:.1f} s")
    print("\n" + (render_order(ctx.order) if ctx.order else "No order proposed."))
    print("\nCriteria: " + ", ".join(f"{k} {'yes' if v else 'NO'}" for k, v in criteria(ctx.order).items()))


if __name__ == "__main__":
    main()
