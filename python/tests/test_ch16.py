"""Chapter 16: the online Comptoir and its authorization server. No call to the API, no network:
the application is called in memory (ASGI), as an HTTP client would."""

import asyncio
import base64
import contextlib
import hashlib
import secrets
import sqlite3
from urllib.parse import parse_qs, urlsplit

import pytest

pytest.importorskip("mcp")
httpx2 = pytest.importorskip("httpx2")

from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.types import ElicitResult

from ch14.make_orders import simulate
from ch15 import comptoir_for_awa as awa
from ch16 import authorization, online_server
from ch16.authorization import hash_password

URL = "http://localhost:8016"
PASSWORD = "password-of-the-tests-16"  # a test value, for this in-memory server only
CALLBACK = "http://localhost:3030/callback"


@pytest.fixture(scope="module")
def model_database(tmp_path_factory):
    path = tmp_path_factory.mktemp("ch16") / "shop.sqlite3"
    simulate(path)
    return path


@pytest.fixture
def app(model_database, tmp_path, monkeypatch):
    copy = tmp_path / "shop.sqlite3"
    copy.write_bytes(model_database.read_bytes())
    monkeypatch.setenv("COMPTOIR_SHOP", str(copy))
    monkeypatch.setenv("COMPTOIR_TODAY", "2026-10-17")
    application = online_server.application(URL, str(tmp_path / "auth.sqlite3"), hash_password(PASSWORD))
    application.state.shop = copy
    return application


@contextlib.asynccontextmanager
async def http(app, host: str = "localhost:8016"):
    async with app.router.lifespan_context(app):
        transport = httpx2.ASGITransport(app=app)
        async with httpx2.AsyncClient(transport=transport, base_url=f"http://{host}") as client:
            yield client


def pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


async def register(client, callbacks=(CALLBACK,)):
    return await client.post("/register", json={"client_name": "Tests", "redirect_uris": list(callbacks),
                                                "token_endpoint_auth_method": "none", "scope": "comptoir"})


async def authorize(client, client_id, challenge, callback=CALLBACK, resource=f"{URL}/mcp"):
    return await client.get("/authorize", params={
        "response_type": "code", "client_id": client_id, "redirect_uri": callback, "code_challenge": challenge,
        "code_challenge_method": "S256", "state": "state-42", "scope": "comptoir", "resource": resource})


async def log_in(client, password=PASSWORD) -> tuple[str, str]:
    """Awa's path up to the token. Returns (client_id, response of the token endpoint)."""
    client_id = (await register(client)).json()["client_id"]
    verifier, challenge = pkce()
    page = (await authorize(client, client_id, challenge)).headers["location"]
    sent = await client.post(page, data={"password": password, "decision": "allow"})
    assert sent.status_code == 302, sent.text
    callback = parse_qs(urlsplit(sent.headers["location"]).query)
    assert callback["state"] == ["state-42"] and callback["iss"] == [URL]  # RFC 9207: the issuer, no trailing slash
    tokens = await client.post("/token", data={
        "grant_type": "authorization_code", "code": callback["code"][0], "redirect_uri": CALLBACK,
        "client_id": client_id, "code_verifier": verifier, "resource": f"{URL}/mcp"})
    return client_id, tokens


def test_without_a_token_the_server_says_where_to_authenticate(app):
    async def _():
        async with http(app) as c:
            refusal = await c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                                   headers={"Accept": "application/json, text/event-stream"})
            resource = (await c.get("/.well-known/oauth-protected-resource/mcp")).json()
            server = (await c.get("/.well-known/oauth-authorization-server")).json()
            return refusal, resource, server
    refusal, resource, server = asyncio.run(_())
    assert refusal.status_code == 401
    assert f'resource_metadata="{URL}/.well-known/oauth-protected-resource/mcp"' in refusal.headers["www-authenticate"]
    assert resource["resource"] == f"{URL}/mcp" and resource["authorization_servers"][0].rstrip("/") == URL
    assert server["issuer"] == URL and server["code_challenge_methods_supported"] == ["S256"]
    assert server["registration_endpoint"] == f"{URL}/register"


def test_a_foreign_callback_address_is_refused(app):
    async def _():
        async with http(app) as c:
            return (await register(c, ["https://example.invalid/theft"])), (await register(c, [authorization.CLAUDE_CALLBACK]))
    foreign, claude = asyncio.run(_())
    assert foreign.status_code == 400 and foreign.json()["error"] == "invalid_redirect_uri"
    assert claude.status_code == 201


def test_the_full_path_opens_the_tools(app):
    async def _():
        async with http(app) as c:
            _, tokens = await log_in(c)
            access = tokens.json()["access_token"]
            c.headers["Authorization"] = f"Bearer {access}"
            async with Client(streamable_http_client(f"{URL}/mcp", http_client=c)) as mcp_client:
                tools = [t.name for t in (await mcp_client.list_tools()).tools]
                stock = (await mcp_client.call_tool("stock", {})).structured_content
                return tokens.json(), tools, stock, mcp_client.protocol_version
    tokens, tools, stock, version = asyncio.run(_())
    assert tokens["token_type"].lower() == "bearer" and tokens["expires_in"] == 3600 and tokens["refresh_token"]
    assert tools[-1] == "weekly_report" and len(tools) == 6
    assert stock["summary"].startswith("Out of stock") and version == "2026-07-28"


def test_the_page_shows_who_is_asking_and_warns_for_a_local_callback(app):
    async def _():
        async with http(app) as c:
            client_id = (await register(c)).json()["client_id"]
            page = (await authorize(c, client_id, pkce()[1])).headers["location"]
            return await c.get(page)
    page = asyncio.run(_())
    assert page.status_code == 200 and "<strong>Tests</strong> is asking for access" in page.text
    assert "<strong>localhost</strong>" in page.text and "The return happens on this computer" in page.text
    assert page.headers["cache-control"] == "no-store" and page.headers["x-frame-options"] == "DENY"
    # The redirection that follows the form must be allowed by the CSP, and only toward this callback.
    assert page.headers["content-security-policy"].endswith("form-action 'self' http://localhost:3030")


def test_the_port_of_a_local_address_can_change(app):
    async def _():
        async with http(app) as c:
            client_id = (await register(c)).json()["client_id"]
            other_port = await authorize(c, client_id, pkce()[1], callback="http://localhost:51234/callback")
            other_path = await authorize(c, client_id, pkce()[1], callback="http://localhost:51234/elsewhere")
            return other_port, other_path
    other_port, other_path = asyncio.run(_())
    assert other_port.status_code == 302 and "/login?request=" in other_port.headers["location"]
    assert other_path.status_code == 400  # the path, for its part, must be the same


def test_a_form_submitted_again_after_success_gets_the_same_redirection(app):
    # Observed during the trial: on a connection that drops, the browser submits the form again.
    async def _():
        async with http(app) as c:
            client_id = (await register(c)).json()["client_id"]
            page = (await authorize(c, client_id, pkce()[1])).headers["location"]
            first = await c.post(page, data={"password": PASSWORD, "decision": "allow"})
            second = await c.post(page, data={"password": PASSWORD, "decision": "allow"})
            return first, second
    first, second = asyncio.run(_())
    assert first.status_code == second.status_code == 302
    assert first.headers["location"] == second.headers["location"]  # the same code, not a second one


def test_five_wrong_passwords_block_login(app):
    async def _():
        async with http(app) as c:
            client_id = (await register(c)).json()["client_id"]
            page = (await authorize(c, client_id, pkce()[1])).headers["location"]
            codes = [(await c.post(page, data={"password": "wrong", "decision": "allow"})).status_code
                     for _ in range(5)]
            blocked = await c.post(page, data={"password": PASSWORD, "decision": "allow"})
            return codes, blocked
    codes, blocked = asyncio.run(_())
    assert codes == [401] * 5 and blocked.status_code == 429 and "Too many attempts" in blocked.text


def test_denying_returns_access_denied(app):
    async def _():
        async with http(app) as c:
            client_id = (await register(c)).json()["client_id"]
            page = (await authorize(c, client_id, pkce()[1])).headers["location"]
            return await c.post(page, data={"decision": "deny"})
    refusal = asyncio.run(_())
    assert refusal.status_code == 302 and "error=access_denied" in refusal.headers["location"]


def test_a_foreign_resource_is_refused(app):
    async def _():
        async with http(app) as c:
            client_id = (await register(c)).json()["client_id"]
            return await authorize(c, client_id, pkce()[1], resource="https://other.invalid/mcp")
    response = asyncio.run(_())
    assert response.status_code == 302 and "error=invalid_target" in response.headers["location"]


def test_rotation_and_theft_of_a_refresh_token(app):
    async def _():
        async with http(app) as c:
            client_id, tokens = await log_in(c)
            first = tokens.json()
            renewed = await c.post("/token", data={"grant_type": "refresh_token", "client_id": client_id,
                                                   "refresh_token": first["refresh_token"]})
            second = renewed.json()
            # The old refresh token comes back: someone copied it. Everything is revoked.
            theft = await c.post("/token", data={"grant_type": "refresh_token", "client_id": client_id,
                                                 "refresh_token": first["refresh_token"]})
            after = await c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                                 headers={"Authorization": f"Bearer {second['access_token']}",
                                          "Accept": "application/json, text/event-stream"})
            return first, renewed, second, theft, after
    first, renewed, second, theft, after = asyncio.run(_())
    assert renewed.status_code == 200 and second["refresh_token"] != first["refresh_token"]
    assert theft.status_code == 400 and theft.json()["error"] == "invalid_grant"
    assert after.status_code == 401


def test_tokens_are_kept_only_as_hashes(app, tmp_path):
    async def _():
        async with http(app) as c:
            return (await log_in(c))[1].json()
    tokens = asyncio.run(_())
    content = (tmp_path / "auth.sqlite3").read_bytes()
    assert tokens["access_token"].encode() not in content and tokens["refresh_token"].encode() not in content
    assert hashlib.sha256(tokens["access_token"].encode()).hexdigest().encode() in content


def test_an_unknown_host_is_refused(app):
    # Without a token, the request stops at the 401. With a valid token, it is the host list that stops it:
    # the protection against DNS rebinding does not depend on authentication.
    async def _():
        async with app.router.lifespan_context(app):  # the transport manager starts only once
            transport = httpx2.ASGITransport(app=app)
            async with httpx2.AsyncClient(transport=transport, base_url="http://localhost:8016") as c:
                access = (await log_in(c))[1].json()["access_token"]
            async with httpx2.AsyncClient(transport=transport, base_url="http://comptoir.example.invalid") as c:
                return await c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                                    headers={"Accept": "application/json, text/event-stream",
                                             "Authorization": f"Bearer {access}"})
    assert asyncio.run(_()).status_code == 421


def test_the_online_server_takes_up_the_desktop_server(app):
    server = app.state.server

    async def _():
        async with Client(awa.server) as desktop, Client(server) as online:
            return ((await desktop.list_tools()).tools, (await online.list_tools()).tools,
                    [p.name for p in (await online.list_prompts()).prompts],
                    [t.uri_template for t in (await online.list_resource_templates()).resource_templates])
    desktop, online, prompts, templates = asyncio.run(_())
    by_name = {t.name: t for t in online}
    for t in desktop:
        assert by_name[t.name].model_dump(exclude={"meta", "output_schema"}) == t.model_dump(exclude={"meta", "output_schema"})
        assert (by_name[t.name].meta or {}).get("anthropic/requiresUserInteraction") == (t.meta or {}).get(
            "anthropic/requiresUserInteraction")
    assert prompts == ["evening_review", "inventory"] and templates == ["comptoir://order/{number}"]


def test_the_report_reports_its_progress(app):
    reports = []

    async def record(done, total, message):
        reports.append((done, total, message))

    async def _():
        async with Client(app.state.server, raise_exceptions=True) as c:
            return await c.call_tool("weekly_report", {"a_day_of_the_week": "2026-10-14"},
                                     progress_callback=record)
    result = asyncio.run(_()).structured_content
    assert [d for d, _, _ in reports] == list(range(1, 9)) and reports[-1][2] == "Report ready"
    assert reports[0][2].startswith("Monday, October 12, 2026: ")
    assert result["sales"]["total_fcfa"] == sum(d["total_fcfa"] for d in result["by_day"])


@pytest.mark.parametrize("answer, expected, message", [
    (ElicitResult(action="accept", content={"confirmed": True}), 32, None),
    (ElicitResult(action="accept", content={"confirmed": False}), 40,
     "Awa did not tick the confirmation: the stock has not changed."),
    (ElicitResult(action="decline"), 40, "Correction declined by Awa: the stock has not changed."),
    (ElicitResult(action="cancel"), 40, "Correction cancelled by Awa: the stock has not changed."),
])
def test_the_correction_asks_for_confirmation_from_the_client_that_can(app, answer, expected, message):
    questions = []

    async def form(_context, params):
        questions.append(params.message)
        return answer

    async def _():
        async with Client(app.state.server, elicitation_callback=form) as c:
            draft = (await c.call_tool("prepare_correction", {"product": "Bissap juice", "counted_quantity": 32})
                     ).structured_content
            return await c.call_tool("apply_correction", {"token": draft["token"]})
    result = asyncio.run(_())
    assert questions == ["Correct the stock of Bissap juice: 40 → 32?"]
    assert result.is_error == (expected == 40)
    if message:  # the tool's message, not the SDK's: the refusal must be told clearly to Awa
        assert result.content[0].text == f"Error executing tool apply_correction: {message}"
    with sqlite3.connect(app.state.shop) as db:
        assert db.execute("SELECT quantity FROM stock WHERE product = 'Bissap juice'").fetchone() == (expected,)


def test_without_a_possible_form_the_token_is_enough(app):
    async def _():
        async with Client(app.state.server) as c:  # no elicitation_callback: like the Claude app
            draft = (await c.call_tool("prepare_correction", {"product": "Bissap juice", "counted_quantity": 32})
                     ).structured_content
            return await c.call_tool("apply_correction", {"token": draft["token"]})
    assert asyncio.run(_()).structured_content["after"] == 32
