"""Chapter 16: speak MCP by hand, over HTTP, to see the messages that the SDKs exchange.

Run, from the python/ folder, after python -m ch16.connect (which keeps a token):
    python -m ch16.raw_client http://localhost:8016/mcp

Three JSON-RPC requests of the 2026-07-28 revision, sent with httpx and nothing else:
server/discover, tools/list, tools/call. On this revision, no handshake: each
request carries its own version, the client's identity and its capabilities (in _meta), and the
server returns no session ID. A request stands on its own.
"""

import argparse
import json
from pathlib import Path

import httpx2

VERSION = "2026-07-28"
TOKENS = Path(__file__).parents[1] / "customer_data" / "client_tokens.json"


def message(identifier: int, method: str, params: dict | None = None) -> dict:
    meta = {"io.modelcontextprotocol/protocolVersion": VERSION,
            "io.modelcontextprotocol/clientInfo": {"name": "yao-raw-client", "version": "0.1"},
            "io.modelcontextprotocol/clientCapabilities": {}}
    return {"jsonrpc": "2.0", "id": identifier, "method": method, "params": {**(params or {}), "_meta": meta}}


def headers(token: str, method: str, name: str | None = None) -> dict:
    h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json",
         "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": VERSION, "Mcp-Method": method}
    if name:
        h["Mcp-Name"] = name  # required for tools/call, resources/read and prompts/get
    return h


def read_response(response: httpx2.Response) -> dict:
    """A JSON response, or an event stream (SSE) of which the final message is kept."""
    if response.headers.get("content-type", "").startswith("text/event-stream"):
        data = [l[5:].strip() for l in response.text.splitlines() if l.startswith("data:")]
        return json.loads(data[-1])
    return response.json()


def send(http: httpx2.Client, address: str, token: str, identifier: int, method: str,
         params: dict | None = None, name: str | None = None) -> dict:
    body = message(identifier, method, params)
    print(f"\n→ POST {address}   Mcp-Method: {method}" + (f"   Mcp-Name: {name}" if name else ""))
    print("  " + json.dumps(body, ensure_ascii=False)[:400])
    response = http.post(address, headers=headers(token, method, name), json=body)
    session = response.headers.get("mcp-session-id")
    print(f"← {response.status_code} {response.headers.get('content-type')}   session: {session or 'none'}")
    result = read_response(response)
    print("  " + json.dumps(result, ensure_ascii=False)[:600])
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("address")
    args = parser.parse_args()
    if not TOKENS.exists():
        raise SystemExit("No token: run python -m ch16.connect first.")
    token = json.loads(TOKENS.read_text(encoding="utf-8"))["tokens"]["access_token"]  # never displayed
    with httpx2.Client(timeout=30) as http:
        send(http, args.address, token, 1, "server/discover")
        send(http, args.address, token, 2, "tools/list")
        send(http, args.address, token, 3, "tools/call", {"name": "stock", "arguments": {}}, name="stock")
        print("\nWithout a token:")
        response = http.post(args.address, headers={k: v for k, v in headers("", "tools/list").items()
                                                     if k != "Authorization"}, json=message(4, "tools/list"))
        print(f"← {response.status_code}   WWW-Authenticate: {response.headers.get('www-authenticate')}")


if __name__ == "__main__":
    main()
