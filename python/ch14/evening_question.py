"""Chapter 14: Awa's evening question, asked to the Comptoir, which reads the database through a local MCP server.

Run, from the python/ folder (PAID CALL):
    python -m ch14.evening_question
    python -m ch14.evening_question "Which juice sold best in Fidjrossè in September?"

The API's MCP connector only reaches remote servers, over HTTP. For a local server, which
talks over stdio, it is your code that is the MCP client: it launches DBHub, asks it for its
tools, and the anthropic SDK converts them for the Tool Runner (async_mcp_tool, extra [mcp]).
Claude writes the SQL queries; the database does the counting; DBHub refuses any write.
"""

import argparse
import asyncio
import json

import anthropic
from anthropic.lib.tools.mcp import async_mcp_tool
from mcp import Client

from ch14.servers import orders
from comptoir import config
from comptoir.costs import cost
from comptoir.log import log_call

QUESTION = ("How many bottles of bissap juice did we sell last week, from Monday, October 12 to "
            "Sunday, October 18, and in which neighborhoods mostly?")

# What Yao learned by exploring the database with Claude Code becomes the Comptoir's context:
# fewer turns to find the schema again, so fewer tokens.
SYSTEM = """You are the Comptoir, the assistant of Délices d'Awa. Awa asks you a question about her sales; you answer it with the execute_sql tool, on a read-only SQLite database.

The database:
- an order (table orders) is a confirmed summary (table summaries, column status = 'confirmed'); orders.summary = summaries.id;
- the products of a summary are in summaries.lines, as JSON: [{"product": ..., "quantity": ..., "unit_price": ...}]; read them with json_each;
- the customer's neighborhood is summaries.neighborhood; the dates (created_at) are in Cotonou time (+01:00);
- the amounts are in FCFA.

Rules:
- the figures come from the database: have SQL do the sums and the counts, never in your head;
- answer Awa in English, politely, in four sentences at most, with the exact figures;
- if the database does not allow you to answer, say so.
Today is Wednesday, October 21, 2026."""


async def ask(question: str, max_budget: float, max_iterations: int = 8) -> tuple[str, float, int]:
    client = anthropic.AsyncAnthropic(timeout=config.TIMEOUT_S, max_retries=config.RETRIES)
    spent, turns, text = 0.0, 0, ""
    async with Client(orders(), read_timeout_seconds=60) as mcp_client:  # launches DBHub, like Claude Code
        tools = (await mcp_client.list_tools()).tools
        runner = client.beta.messages.tool_runner(
            model=config.MODEL,
            max_tokens=2000,
            system=SYSTEM,
            messages=[{"role": "user", "content": question}],
            tools=[async_mcp_tool(tool, mcp_client) for tool in tools],
            max_iterations=max_iterations,
        )
        async for message in runner:
            turns += 1
            price = cost(config.MODEL, message.usage)
            spent += price.dollars
            log_call(message._request_id, config.MODEL, price, customer="ch14-evening",
                     stop_reason=message.stop_reason, origin="local-mcp")
            for block in message.content:
                if block.type == "tool_use":
                    print(f"SQL: {json.dumps(block.input, ensure_ascii=False)}")
                elif block.type == "text":
                    text = block.text
            if spent >= max_budget and message.stop_reason == "tool_use":
                print(f"Stop: ${spent:.4f} spent, ceiling of ${max_budget} reached.")
                break
    return text, spent, turns


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("question", nargs="?", default=QUESTION)
    parser.add_argument("--max-budget", type=float, default=0.10)
    args = parser.parse_args()
    text, spent, turns = asyncio.run(ask(args.question, args.max_budget))
    print(f"\n{text}\n\n{turns} turn(s), ${spent:.4f}")


if __name__ == "__main__":
    main()
