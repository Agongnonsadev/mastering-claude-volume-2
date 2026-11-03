"""Chapter 16: log in to the online Comptoir the way an MCP client does, OAuth included.

Run, from the python/ folder, with the server running (see online_server.py):
    python -m ch16.connect http://localhost:8016/mcp               # with your browser
    python -m ch16.connect http://localhost:8016/mcp --automatic   # local trial, without a browser

What the client does, in order: it calls /mcp without a token and receives a 401 that points to
the resource's metadata; it reads there the address of the authorization server; it registers
(dynamic registration); it opens the login page, with a PKCE challenge; it receives a code
at its callback address; it exchanges it for a token; it calls /mcp again with this token. The SDK
does all of this: this script provides only the browser and the callback address.

--automatic replaces the browser with a request that fills in the login page with the password
of COMPTOIR_TEST_PASSWORD: for a test server, on your computer, only.
The tokens are kept in customer_data/client_tokens.json (excluded from Git).
"""

import argparse
import asyncio
import json
import os
import re
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx2
from pydantic import AnyUrl

from mcp import Client
from mcp.client.auth import AuthorizationCodeResult, OAuthClientProvider
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata, OAuthToken
from mcp.types import ElicitResult

from ch16.authorization import SCOPE

ROOT = Path(__file__).parents[1]
TOKENS = ROOT / "customer_data" / "client_tokens.json"
CALLBACK_PORT = 3030


class FileStorage:
    """The tokens and the client's registration, in a file: the next connection is silent."""

    def __init__(self, path: Path = TOKENS):
        self.path = path

    def _read(self) -> dict:
        return json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {}

    def _write(self, key: str, value: dict) -> None:
        data = self._read() | {key: value}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    async def get_tokens(self) -> OAuthToken | None:
        d = self._read().get("tokens")
        return OAuthToken.model_validate(d) if d else None

    async def set_tokens(self, tokens: OAuthToken) -> None:
        self._write("tokens", tokens.model_dump(mode="json"))

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        d = self._read().get("client")
        return OAuthClientInformationFull.model_validate(d) if d else None

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        self._write("client", client_info.model_dump(mode="json"))


def _callback_result(address: str) -> AuthorizationCodeResult:
    params = parse_qs(urlsplit(address).query)
    if "error" in params:
        raise SystemExit(f"Connection refused: {params['error'][0]}")
    return AuthorizationCodeResult(code=params["code"][0], state=params.get("state", [None])[0],
                                   iss=params.get("iss", [None])[0])


def simulated_browser(password: str):
    """What Awa's browser would do: follow /authorize, fill in the page, bring back the callback address."""
    callback: asyncio.Future = asyncio.get_event_loop().create_future()

    async def open_page(address: str) -> None:
        async with httpx2.AsyncClient(follow_redirects=False, timeout=10) as http:
            response = await http.get(address)
            while response.status_code in (302, 307) and "/login" not in str(response.url):
                response = await http.get(urljoin(str(response.url), response.headers["location"]))
            assert "Comptoir for Awa" in response.text, "login page expected"
            sent = await http.post(str(response.url), data={"password": password, "decision": "allow"})
            if sent.status_code != 302:
                raise SystemExit(f"Connection refused by the page ({sent.status_code}): "
                                 + re.sub(r"<[^>]+>", " ", sent.text)[-200:])
            callback.set_result(_callback_result(sent.headers["location"]))

    async def wait() -> AuthorizationCodeResult:
        return await callback

    return open_page, wait


def real_browser():
    """Opens the browser, and waits for the return on http://localhost:3030/callback."""
    received: dict = {}

    class Callback(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 (name imposed by http.server)
            received["address"] = self.path
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("<p>Done: you can close this page.</p>".encode())

        def log_message(self, *_):
            pass

    server = HTTPServer(("127.0.0.1", CALLBACK_PORT), Callback)

    async def open_page(address: str) -> None:
        Thread(target=server.handle_request, daemon=True).start()
        print(f"Open this page if the browser does not open: {address}")
        webbrowser.open(address)

    async def wait() -> AuthorizationCodeResult:
        while "address" not in received:
            await asyncio.sleep(0.2)
        server.server_close()
        return _callback_result(received["address"])

    return open_page, wait


async def accept(_context, params) -> ElicitResult:
    """The confirmation form, in the console: this is where Awa would say yes."""
    print(f"\n[server form] {params.message}")
    if os.environ.get("COMPTOIR_FORM_ANSWER"):
        answer = os.environ["COMPTOIR_FORM_ANSWER"]
    else:
        answer = input("Confirm? (y/n) ").strip().lower()
    print(f"[answer] {answer}")
    return ElicitResult(action="accept", content={"confirmed": answer == "y"})


async def progress(done: float, total: float | None, message: str | None) -> None:
    print(f"  [{int(done)}/{int(total or 0)}] {message}")


async def main(address: str, automatic: bool, product: str, count: int) -> None:
    if automatic:
        password = os.environ.get("COMPTOIR_TEST_PASSWORD", "")
        # A test server only: your computer, or the test host you name (a tunnel).
        hosts = {"localhost", "127.0.0.1", os.environ.get("COMPTOIR_TEST_HOST", "")} - {""}
        if not password or urlsplit(address).hostname not in hosts:
            raise SystemExit("--automatic: only on a test server, with COMPTOIR_TEST_PASSWORD.")
        open_page, wait = simulated_browser(password)
    else:
        open_page, wait = real_browser()
    oauth = OAuthClientProvider(
        server_url=address,
        client_metadata=OAuthClientMetadata(client_name="Yao's script", scope=SCOPE,
                                            redirect_uris=[AnyUrl(f"http://localhost:{CALLBACK_PORT}/callback")],
                                            token_endpoint_auth_method="none"),
        storage=FileStorage(), redirect_handler=open_page, callback_handler=wait)
    async with httpx2.AsyncClient(auth=oauth, timeout=httpx2.Timeout(30.0, read=120.0)) as http:
        async with Client(streamable_http_client(address, http_client=http), elicitation_callback=accept) as client:
            print(f"Connected: {client.server_info.name} {client.server_info.version}, protocol {client.protocol_version}")
            print("Tools:", ", ".join(t.name for t in (await client.list_tools()).tools))
            print("Stock:", (await client.call_tool("stock", {})).structured_content["summary"])
            print("Weekly report:")
            report = await client.call_tool("weekly_report", {"a_day_of_the_week": "2026-10-14"},
                                            progress_callback=progress)
            print(" ", report.structured_content["summary"])
            draft = (await client.call_tool("prepare_correction", {"product": product, "counted_quantity": count})
                     ).structured_content
            print("Preparation:", draft["to_tell_awa"])
            done = await client.call_tool("apply_correction", {"token": draft["token"]})
            print("Application:", done.structured_content["summary"] if not done.is_error else done.content[0].text)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("address")
    parser.add_argument("--automatic", action="store_true")
    parser.add_argument("--product", default="Bissap juice")
    parser.add_argument("--count", type=int, default=38)
    args = parser.parse_args()
    asyncio.run(main(args.address, args.automatic, args.product, args.count))
