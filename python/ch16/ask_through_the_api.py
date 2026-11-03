"""Chapter 16: query the online Comptoir from the API, through the MCP connector, with an OAuth token.

Run, from the python/ folder (PAID CALL), after python -m ch16.connect on the same
public address (which keeps the token in customer_data/client_tokens.json):
    python -m ch16.ask_through_the_api https://<public-address>/mcp

The MCP connector only reaches a public server, over https://. It is up to your application to obtain the
OAuth token and to renew it: the API simply presents it to the server (authorization_token).
Here, a denylist: all the server's tools, except the two that touch the stock. The resulting
assistant can only read.
"""

import argparse
import json
from pathlib import Path

from ch14.ask_the_docs import trace
from comptoir import config
from comptoir.call import make_client
from comptoir.costs import cost
from comptoir.log import log_call

TOKENS = Path(__file__).parents[1] / "customer_data" / "client_tokens.json"
QUESTION = ("How many orders did we have on Saturday, October 17, 2026, for what total, and which products "
            "are out of stock?")


def request(address: str, token: str) -> dict:
    return {
        "model": config.DOCUMENTS_MODEL,
        "max_tokens": 800,
        "system": "You answer Awa, in English, politely, in two sentences, with the exact figures from the tools.",
        "messages": [{"role": "user", "content": QUESTION}],
        "mcp_servers": [{"type": "url", "url": address, "name": "comptoir", "authorization_token": token}],
        "tools": [{"type": "mcp_toolset", "mcp_server_name": "comptoir",
                   # Denylist: everything is allowed, except what writes.
                   "configs": {"prepare_correction": {"enabled": False},
                               "apply_correction": {"enabled": False}}}],
        "betas": ["mcp-client-2025-11-20"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("address")
    args = parser.parse_args()
    if not args.address.startswith("https://"):
        raise SystemExit("The MCP connector accepts only an https:// address.")
    token = json.loads(TOKENS.read_text(encoding="utf-8"))["tokens"]["access_token"]  # never displayed
    params = request(args.address, token)
    message = make_client().beta.messages.create(**params)
    price = cost(params["model"], message.usage)
    log_call(message._request_id, params["model"], price, customer="ch16-api", stop_reason=message.stop_reason,
             origin="mcp-connector-oauth")
    for line in trace(message.content):
        print(line)
    text = "".join(b.text for b in message.content if b.type == "text")
    right = "6 orders" in text and "50" in text and "500" in text and "soursop" in text.lower()
    print(f"\n{text}\n\n{'Right' if right else 'TO CHECK'}; stop: {message.stop_reason}; "
          f"{message.usage.input_tokens} input tokens; cost: ${price.dollars:.4f}")


if __name__ == "__main__":
    main()
