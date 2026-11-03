"""Chapter 14: look at an MCP server before entrusting it to Claude. No call to the Claude API.

Run, from the python/ folder:
    python -m ch14.explore_server orders                     # DBHub on the exploration copy
    python -m ch14.explore_server orders --try-to-write
    python -m ch14.explore_server everything                 # sample tools, resources and prompts
    python -m ch14.explore_server doc                        # Anthropic's documentation

The script behaves like an MCP client: it connects, shows the negotiated protocol version,
the server's instructions and the full description of each tool, resource and prompt.
That is the text Claude will read as instructions: it must be read before Claude does.
"""

import argparse
import asyncio
import re
import sqlite3
import sys

from mcp import Client

from ch14.servers import ROOT, SERVERS

# Phrasings that have no business in a tool's description: a server that uses them may be
# trying to steer Claude (tool poisoning). It is only an alert: nothing replaces reading.
SUSPICIOUS = re.compile(
    r"ignore (all|any|previous|the above)|instead of|do not tell|don't tell"
    r"|system prompt|<important>|before using any other tool"
    r"|send .{0,40}to https?://|~/\.ssh|\.env\b|api[_ -]?key|password",
    re.IGNORECASE,
)


def alerts(text: str | None) -> list[str]:
    """The passages of a description that deserve a careful reread."""
    return sorted({m.group(0) for m in SUSPICIOUS.finditer(text or "")})


def _short(text: str | None, width: int = 400) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= width else text[: width - 1] + "…"


async def explore(name: str) -> int:
    flagged = 0
    async with Client(SERVERS[name](), read_timeout_seconds=60) as client:
        info = client.server_info
        print(f"Server: {getattr(info, 'name', '?')} {getattr(info, 'version', '')}")
        print(f"Negotiated protocol: {client.protocol_version}")
        if client.instructions:
            print(f"Server instructions: {_short(client.instructions)}")
        capabilities = client.server_capabilities

        tools = (await client.list_tools()).tools
        print(f"\n{len(tools)} tool(s)")
        for tool in tools:
            properties = list((tool.input_schema or {}).get("properties", {}))
            annotations = tool.annotations.model_dump(exclude_none=True) if tool.annotations else {}
            print(f"- {tool.name}({', '.join(properties)}) {annotations or ''}")
            print(f"    {_short(tool.description, 600)}")
            for passage in alerts(tool.description):
                flagged += 1
                print(f"    ⚠ to reread: “{passage}”")

        if capabilities and capabilities.resources:
            resources = (await client.list_resources()).resources
            print(f"\n{len(resources)} resource(s)")
            for r in resources[:10]:
                print(f"- {r.uri}  ({r.mime_type or '?'}) {_short(r.name, 80)}")
            if len(resources) > 10:
                print(f"  … and {len(resources) - 10} more")
        if capabilities and capabilities.prompts:
            prompts = (await client.list_prompts()).prompts
            print(f"\n{len(prompts)} prompt(s)")
            for p in prompts:
                arguments = [a.name for a in (p.arguments or [])]
                print(f"- {p.name}({', '.join(arguments)}): {_short(p.description, 200)}")
    print(f"\n{flagged} passage(s) to reread." if flagged else "\nNo suspicious phrasing found.")
    return flagged


def count_orders() -> int:
    with sqlite3.connect(ROOT / "customer_data" / "orders_exploration.sqlite3") as db:
        return db.execute("SELECT COUNT(*) FROM orders").fetchone()[0]


async def try_to_write() -> bool:
    """Asks the orders server to delete an order. Returns True if the write is refused."""
    before = count_orders()
    async with Client(SERVERS["orders"](), read_timeout_seconds=60) as client:
        read = await client.call_tool("execute_sql", {"sql": "SELECT COUNT(*) AS orders FROM orders"})
        print("Read:", _short(" ".join(c.text for c in read.content if c.type == "text"), 200))
        write = await client.call_tool("execute_sql", {"sql": "DELETE FROM orders WHERE id = 'C-0001'"})
        print("Write:", "refused" if write.is_error else "ACCEPTED",
              "—", _short(" ".join(c.text for c in write.content if c.type == "text"), 300))
    after = count_orders()
    print(f"Orders in the copy: {before} before, {after} after.")
    return bool(write.is_error) and before == after


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("server", choices=sorted(SERVERS))
    parser.add_argument("--try-to-write", action="store_true",
                        help="check that the orders server refuses a write")
    args = parser.parse_args()
    if args.try_to_write:
        if args.server != "orders":
            parser.error("--try-to-write only applies to the orders server")
        sys.exit(0 if asyncio.run(try_to_write()) else 1)
    asyncio.run(explore(args.server))


if __name__ == "__main__":
    main()
