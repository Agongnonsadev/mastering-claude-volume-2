"""Chapter 14: check the Comptoir's prices in Anthropic's documentation, through the MCP connector.

Run, from the python/ folder (PAID CALL):
    python -m ch14.ask_the_docs                    # allowlist: search_docs and get_doc
    python -m ch14.ask_the_docs --pin              # the same, with a pinned tool list

The API's MCP connector (beta) plugs a remote MCP server into a request: it is the API that
connects to the server, calls its tools and returns everything in a single response. Here, the
official server of the documentation (https://platform.claude.com/docs/mcp, public, without
authentication). Claude looks for the prices and returns them as JSON; the code compares them with
comptoir/costs.py. Claude does not decide whether a price has changed: it reads it, the code compares.

--pin: with the header mcp-client-2026-09-15, the first response returns the server's tool list;
the script saves it in ch14/pinned_tools/doc-claude.json. The following times, it sends this list:
the API no longer asks the server about its tools, and a server that changed its descriptions
would not change what Claude reads. Before each call, the script compares the pinned list
with the one the server announces today (free) and stops if it has changed.
"""

import argparse
import asyncio
import json

from mcp import Client

from ch14.servers import DOC_CLAUDE, ROOT
from comptoir import config
from comptoir.call import make_client
from comptoir.costs import RATES, cost
from comptoir.log import log_call

SERVER = "doc-claude"
BETA = "mcp-client-2025-11-20"
PIN_BETA = "mcp-client-2026-09-15"
PIN = ROOT / "ch14" / "pinned_tools" / f"{SERVER}.json"
CHECKED_MODELS = ("claude-sonnet-5-5", "claude-haiku-5-5")
ITEMS = ("input", "write_5m", "write_1h", "cache_read", "output")

SYSTEM = (
    "You check facts in Claude's official documentation, with the tools of the doc-claude MCP server. "
    "Never answer from memory: search, read the page, then copy the figures as the page gives them. "
    "If a figure is not there, put the model in not_found rather than guess."
)

SCHEMA = {
    "type": "object",
    "properties": {
        "prices": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "model": {"type": "string", "description": "the model's ID, for example claude-haiku-5-5"},
                **{item: {"type": "number", "description": "dollars per million tokens"} for item in ITEMS},
                "source": {"type": "string", "description": "address of the page read"},
            },
            "required": ["model", *ITEMS, "source"],
            "additionalProperties": False,
        }},
        "not_found": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["prices", "not_found"],
    "additionalProperties": False,
}


def question() -> str:
    return (
        "Give, for " + " and ".join(CHECKED_MODELS) + ", the published prices per million tokens: input, "
        "writing to the 5-minute cache, writing to the one-hour cache, reading from the cache, output. "
        "Take the API's base prices (not the Batch API, not long prompts)."
    )


def toolset(pinned: list[dict] | None) -> dict:
    """The allowlist: every tool turned off by default, then two turned back on."""
    tools = {"type": "mcp_toolset", "mcp_server_name": SERVER,
             "default_config": {"enabled": False},
             "configs": {"search_docs": {"enabled": True}, "get_doc": {"enabled": True}}}
    if pinned is not None:
        tools["tools"] = pinned
    return tools


def request(pinned: list[dict] | None, beta: str) -> dict:
    return {
        "model": config.DOCUMENTS_MODEL,
        "max_tokens": 3000,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": question()}],
        "mcp_servers": [{"type": "url", "url": DOC_CLAUDE, "name": SERVER}],
        "tools": [toolset(pinned)],
        "output_config": {"format": {"type": "json_schema", "schema": SCHEMA}},
        "betas": [beta],
    }


def _dict(block) -> dict:
    return block.model_dump(exclude_none=True) if hasattr(block, "model_dump") else dict(block)


def trace(content: list) -> list[str]:
    """What happened in the response, block by block: the trace of a call with the connector."""
    lines = []
    for block in map(_dict, content):
        if block["type"] == "mcp_tool_listing":
            lines.append(f"tool list of {block['mcp_server_name']}: {len(block['tools'])} tool(s)")
        elif block["type"] == "mcp_tool_use":
            lines.append(f"call {block['server_name']}.{block['name']} {json.dumps(block['input'], ensure_ascii=False)}")
        elif block["type"] == "mcp_tool_result":
            size = sum(len(c.get("text", "")) for c in block.get("content") or [])
            lines.append(f"  result {'in error' if block.get('is_error') else 'received'}: {size} characters")
        elif block["type"] == "text":
            lines.append(f"text: {len(block['text'])} characters")
    return lines


def compare(answer: dict) -> list[str]:
    """The gaps between the prices read in the documentation and those of comptoir/costs.py."""
    gaps = [f"{m}: price not found in the documentation" for m in answer.get("not_found", [])]
    seen = set()
    for line in answer["prices"]:
        model = line["model"]
        if model not in CHECKED_MODELS:
            continue
        seen.add(model)
        rate = RATES[model]
        for item in ITEMS:
            if abs(getattr(rate, item) - line[item]) > 1e-9:
                gaps.append(f"{model} {item}: ${getattr(rate, item)} in costs.py, "
                            f"${line[item]} in the documentation ({line['source']})")
    gaps += [f"{m}: missing from the answer" for m in CHECKED_MODELS if m not in seen]
    return gaps


async def announced_tools() -> list[dict]:
    """The tool list the server announces today, in the connector's format. Free."""
    async with Client(DOC_CLAUDE) as client:
        return [{"name": t.name, "description": t.description, "input_schema": t.input_schema}
                for t in (await client.list_tools()).tools]


def pin_up_to_date(pinned: list[dict], announced: list[dict]) -> list[str]:
    """The tools whose definition has changed since the pinning (or appeared, or disappeared)."""
    before = {t["name"]: t for t in pinned}
    now = {t["name"]: t for t in announced}
    changed = [n for n in before.keys() & now.keys() if before[n] != now[n]]
    return sorted(changed + [f"+{n}" for n in now.keys() - before.keys()]
                  + [f"-{n}" for n in before.keys() - now.keys()])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pin", action="store_true", help="pin the server's tool list")
    parser.add_argument("--max-budget", type=float, default=0.10, help="ceiling of the session, in dollars")
    args = parser.parse_args()

    pinned, beta = None, BETA
    if args.pin:
        beta = PIN_BETA
        if PIN.exists():
            pinned = json.loads(PIN.read_text(encoding="utf-8"))
            changed = pin_up_to_date(pinned, asyncio.run(announced_tools()))
            if changed:
                raise SystemExit(f"The server has changed its tools since the pinning: {', '.join(changed)}. "
                                 f"Reread them (python -m ch14.explore_server doc), then delete {PIN.name} "
                                 "to pin the new list.")
            print(f"Pinned tool list: {len(pinned)} tool(s), identical to the server's.")

    client = make_client()
    params = request(pinned, beta)
    messages = list(params.pop("messages"))
    spent, calls = 0.0, 0
    while True:
        # No prior counting: the count_tokens endpoint rejects mcp_servers, and the tools' results
        # come in during the call. The ceiling is therefore checked after each call.
        message = client.beta.messages.create(messages=messages, **params)
        calls += 1
        price = cost(params["model"], message.usage)
        spent += price.dollars
        log_call(message._request_id, params["model"], price, customer="ch14-doc", stop_reason=message.stop_reason,
                 origin="mcp-connector")
        for line in trace(message.content):
            print(line)
        if args.pin and pinned is None:
            for block in map(_dict, message.content):
                if block["type"] == "mcp_tool_listing" and block["mcp_server_name"] == SERVER:
                    PIN.parent.mkdir(parents=True, exist_ok=True)
                    PIN.write_text(json.dumps(block["tools"], ensure_ascii=False, indent=2), encoding="utf-8")
                    print(f"Tool list pinned in {PIN.relative_to(ROOT)}")
                    pinned = block["tools"]
        if message.stop_reason != "pause_turn":
            break
        if spent >= args.max_budget or calls >= 4:
            raise SystemExit(f"Stop: ${spent:.4f} spent in {calls} calls, ceiling reached.")
        # pause_turn: the API interrupted a long round of tools; its response is sent back as is.
        messages.append({"role": "assistant", "content": [_dict(b) for b in message.content]})

    text = "".join(b.text for b in message.content if b.type == "text")
    answer = json.loads(text)
    gaps = compare(answer)
    print()
    for line in answer["prices"]:
        print(f"{line['model']}: " + ", ".join(f"{i} {line[i]}" for i in ITEMS) + f"  ({line['source']})")
    print("\nPrices in comptoir/costs.py:", "up to date." if not gaps else "GAPS")
    for g in gaps:
        print(" -", g)
    print(f"\n{calls} call(s), {message.usage.input_tokens} input tokens at the last one, cost: ${spent:.4f}")
    if spent > args.max_budget:
        print(f"Warning: the ceiling of ${args.max_budget} is exceeded; it can only be checked after the call.")


if __name__ == "__main__":
    main()
