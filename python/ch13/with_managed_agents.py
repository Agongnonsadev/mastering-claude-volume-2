"""Chapter 13: the same agent, hosted by Anthropic with Claude Managed Agents (beta).

Anthropic runs the agent loop; the workshop's tools stay on your side. They are custom
tools: the session emits a call, this script runs it with the same functions as with the
Tool Runner, and sends back the result. No built-in tool is turned on: neither bash, nor
files, nor web. A session budget, in cents of a dollar, caps the spending; a timeout
interrupts the session if it takes too long.

At the end, the session, the agent and the environment are archived: their history remains readable,
and nothing can run any more. Nothing is deleted.

Run, from the python/ folder:  python -m ch13.with_managed_agents --budget-cents 100
"""

import argparse
import copy
import time

import anthropic
from anthropic.tools import ToolError

from ch13.criteria import criteria
from comptoir import config
from comptoir.restock_agent import INSTRUCTION, SYSTEM, Context, Guard, Settings, make_tools
from comptoir.trace import Trace
from comptoir.workshop import Workshop, render_order


def without_references(schema: dict) -> dict:
    """Replaces the $ref with their definition: a custom tool schema all in one block."""
    definitions = schema.get("$defs", {})

    def replace(node):
        if isinstance(node, dict):
            if "$ref" in node:
                return replace(copy.deepcopy(definitions[node["$ref"].split("/")[-1]]))
            return {k: replace(v) for k, v in node.items() if k != "$defs"}
        if isinstance(node, list):
            return [replace(v) for v in node]
        return node

    return replace(schema)


def custom_tools(tools) -> list[dict]:
    return [{"type": "custom", "name": t.name, "description": t.description, "input_schema": without_references(t.input_schema)}
            for t in tools]


def execute(tools: dict, name: str, arguments: dict) -> tuple[str, bool]:
    try:
        return tools[name].call(arguments), False
    except ToolError as error:
        return str(error), True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--budget-cents", type=int, default=100, help="hard ceiling of the session, in cents of a dollar")
    parser.add_argument("--timeout", type=float, default=600, help="in seconds: beyond it, the session is interrupted")
    args = parser.parse_args()

    client = anthropic.Anthropic()
    ctx = Context(client, Workshop(), Guard(), Trace())
    tools = {t.name: t for t in make_tools(ctx, Settings(subagent=True))}
    environment = client.beta.environments.create(
        name="awa-workshop-ch13", config={"type": "cloud", "networking": {"type": "limited"}})
    agent = client.beta.agents.create(name="Délices d'Awa restocking (chapter 13)", model=config.MODEL,
                                      system=SYSTEM, tools=custom_tools(tools.values()))
    session = client.beta.sessions.create(
        agent=agent.id, environment_id=environment.id, title="Order of October 19, 2026",
        budget={"type": "limit", "max_list_cost": {"amount": str(args.budget_cents), "currency": "USD"}})
    print(f"Environment {environment.id}, agent {agent.id} (version {agent.version}), session {session.id}")

    start, texts, calls, end = time.perf_counter(), [], [], None
    try:
        with client.beta.sessions.events.stream(session.id) as stream:
            # The stream only delivers the events emitted after it is opened: it is opened first.
            client.beta.sessions.events.send(session.id, events=[
                {"type": "user.message", "content": [{"type": "text", "text": INSTRUCTION}]}])
            for event in stream:
                if time.perf_counter() - start > args.timeout:
                    client.beta.sessions.events.send(session.id, events=[{"type": "user.interrupt"}])
                    end = "timeout exceeded: session interrupted"
                    break
                if event.type == "agent.custom_tool_use":
                    calls.append(event.name)
                    text, error = execute(tools, event.name, dict(event.input))
                    client.beta.sessions.events.send(session.id, events=[{
                        "type": "user.custom_tool_result", "custom_tool_use_id": event.id,
                        "content": [{"type": "text", "text": text}], "is_error": error}])
                elif event.type == "agent.message":
                    texts += [b.text for b in event.content if b.type == "text"]
                elif event.type == "session.status_idle":
                    reason = event.stop_reason.type if event.stop_reason else None
                    if reason in ("end_turn", "budget_reached"):
                        end = reason
                        break
                    # requires_action: the results have already gone, the session restarts on its own.
    finally:
        duration = time.perf_counter() - start
        reread = client.beta.sessions.retrieve(session.id)
        print(f"\nEnd: {end}; {duration:.1f} s; tool calls: {calls}")
        print(f"Usage of the session: {reread.usage}")
        print(f"Of which subagent (called by our code): ${ctx.subagent_cost:.4f}")
        for name, archive, identifier in (("session", client.beta.sessions.archive, session.id),
                                          ("agent", client.beta.agents.archive, agent.id),
                                          ("environment", client.beta.environments.archive, environment.id)):
            try:
                archive(identifier)
                print(f"{name} archived")
            except anthropic.APIError as error:
                print(f"{name} NOT archived: {error}")

    print("\nThe agent's summary:\n" + "\n".join(texts[-1:]))
    print("\n" + (render_order(ctx.order) if ctx.order else "No order proposed."))
    print("\nCriteria: " + ", ".join(f"{k} {'yes' if v else 'NO'}" for k, v in criteria(ctx.order).items()))


if __name__ == "__main__":
    main()
