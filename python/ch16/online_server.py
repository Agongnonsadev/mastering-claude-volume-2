"""Chapter 16: “Comptoir for Awa” online, in Streamable HTTP, stateless, behind OAuth.

Local run, from the python/ folder:
    COMPTOIR_PUBLIC_URL=http://localhost:8016 COMPTOIR_SHOP=... COMPTOIR_PASSWORD_HASH=... \\
        uvicorn ch16.online_server:app --port 8016

It is the server of chapter 15, to the character: the tools, the resource, the template and the
prompts are copied from ch15/comptoir_for_awa.py by the SDK itself. What changes:
- the transport: HTTP instead of stdio, to be reached from Awa's phone;
- the access: an OAuth token (ch16/authorization.py), issued after Awa's password;
- a long-running tool, weekly_report, which sends progress notifications;
- apply_correction also asks for a confirmation through a form from the client that can show it
  (elicitation, in several round trips on the 2026-07-28 revision), and relies on the
  preparation token for the others, like the Claude app;
- stateless: no session, the tokens and the corrections are in SQLite databases; several
  processes can serve the same clients.

Configuration (environment variables):
  COMPTOIR_PUBLIC_URL        the public address, in https:// online (http://localhost:… locally)
  COMPTOIR_SHOP              the shop's database (SQLite)
  COMPTOIR_AUTHORIZATION     the token database (default customer_data/authorization.sqlite3)
  COMPTOIR_PASSWORD_HASH     output of “python -m ch16.authorization hash”
  COMPTOIR_EXTRA_HOSTS       other accepted host names, separated by commas (optional)
"""

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import BaseModel, Field
from starlette.requests import Request
from starlette.responses import JSONResponse

from mcp import Client
from mcp.server import MCPServer
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions, RevocationOptions
from mcp.server.mcpserver import (CancelledElicitation, Context, DeclinedElicitation, Elicit, ElicitationResult,
                                  Resolve)
from mcp.server.transport_security import TransportSecuritySettings

from ch15 import comptoir_for_awa as awa
from ch16.authorization import SCOPE, AwaProvider

log = logging.getLogger("comptoir_online")

INSTRUCTIONS = awa.INSTRUCTIONS + (
    "\n5. For a complete weekly report (day by day, neighborhoods, comparison), use "
    "weekly_report: it takes a few seconds and reports its progress.")


def _definitions() -> tuple[list, list, list, list]:
    """The definitions of the chapter 15 server, read by an in-memory MCP client.

    In a separate thread: at import by uvicorn, an event loop is already running."""
    async def read():
        async with Client(awa.server) as client:
            return ((await client.list_tools()).tools, (await client.list_resources()).resources,
                    (await client.list_resource_templates()).resource_templates, (await client.list_prompts()).prompts)
    with ThreadPoolExecutor(1) as thread:
        return thread.submit(asyncio.run, read()).result()


class Confirmation(BaseModel):
    confirmed: bool = Field(description="Tick to apply the correction.")


async def confirm(token: str, ctx: Context) -> Confirmation | Elicit[Confirmation]:
    """Asks for confirmation through a form if the client can show one; otherwise, the token is enough."""
    capabilities = ctx.client_capabilities
    log.info("confirmation: protocol %s, form possible: %s", ctx.protocol_version,
             bool(capabilities and capabilities.elicitation))
    if capabilities is None or capabilities.elicitation is None:
        return Confirmation(confirmed=True)  # consent was given in the conversation, on the announced difference
    with awa._open() as db:
        db.execute(awa._CORRECTIONS_TABLE)
        line = db.execute("SELECT product, before, after FROM stock_corrections WHERE token = ?", (token.strip(),)
                          ).fetchone()
    if line is None:
        return Confirmation(confirmed=True)  # apply() will refuse the token, with its own message
    return Elicit(f"Correct the stock of {line['product']}: {line['before']} → {line['after']}?", Confirmation)


class ReportDay(BaseModel):
    day: str
    orders: int
    total_fcfa: int


class WeekReport(BaseModel):
    sales: awa.WeekSales
    by_day: list[ReportDay]
    by_neighborhood: dict[str, int] = Field(description="Total in FCFA per neighborhood, from the highest to the lowest.")
    summary: str


def build(public_url: str, authorization_path: str, password_hash: str) -> MCPServer:
    url = public_url.rstrip("/")
    resource = f"{url}/mcp"
    provider = AwaProvider(authorization_path, url, resource, password_hash)
    server = MCPServer(
        "comptoir-for-awa", title="Comptoir for Awa", version=awa.VERSION, instructions=INSTRUCTIONS,
        auth_server_provider=provider,
        auth=AuthSettings(
            # Strings, not AnyHttpUrl(...): AuthSettings keeps the address without a trailing slash, and the issuer
            # announced must be identical to the iss parameter that the login page returns (RFC 9207).
            issuer_url=url, resource_server_url=resource, required_scopes=[SCOPE],
            validate_token_resource=True,
            client_registration_options=ClientRegistrationOptions(enabled=True, valid_scopes=[SCOPE],
                                                                  default_scopes=[SCOPE]),
            revocation_options=RevocationOptions(enabled=True)))

    tools, resources, templates, prompts = _definitions()  # read from ch15.comptoir_for_awa.server
    for t in tools:
        if t.name == "apply_correction":
            continue  # redefined below, with the confirmation
        server.add_tool(getattr(awa, t.name), name=t.name, title=t.title, description=t.description,
                        annotations=t.annotations, meta=t.meta)
    for r in resources:
        server.resource(str(r.uri), name=r.name, title=r.title, description=r.description,
                        mime_type=r.mime_type)(getattr(awa, r.name))
    for t in templates:
        server.resource(t.uri_template, name=t.name, title=t.title, description=t.description,
                        mime_type=t.mime_type)(getattr(awa, t.name))
    for p in prompts:
        server.prompt(name=p.name, title=p.title, description=p.description)(getattr(awa, p.name))

    apply = next(t for t in tools if t.name == "apply_correction")

    @server.tool(name=apply.name, title=apply.title, annotations=apply.annotations, meta=apply.meta,
                 description=apply.description)
    def apply_correction(
        token: Annotated[str, Field(description="The token returned by prepare_correction.")],
        # ElicitationResult alone: the SDK then passes the refusal and the cancellation to the tool, which answers
        # itself. A union with Confirmation, it does not recognize: it would stop the call before, with its own
        # message. The Confirmation that confirm() returns without a form arrives as an acceptance.
        confirmation: Annotated[ElicitationResult[Confirmation], Resolve(confirm)],
    ) -> awa.AppliedCorrection:
        refusals = {DeclinedElicitation: "declined", CancelledElicitation: "cancelled"}
        if type(confirmation) in refusals:
            raise awa.ToolError(f"Correction {refusals[type(confirmation)]} by Awa: the stock has not changed.")
        if not confirmation.data.confirmed:
            raise awa.ToolError("Awa did not tick the confirmation: the stock has not changed.")
        with awa._open() as db:
            return awa.apply(db, token, awa._now())

    @server.tool(title="Weekly report", annotations=awa.READ_ONLY)
    async def weekly_report(
        ctx: Context,
        a_day_of_the_week: Annotated[date | None, Field(
            description="YYYY-MM-DD, any day of the week wanted. Without a date: the current week.")] = None,
    ) -> WeekReport:
        """The complete report of a week: sales, day by day, by neighborhood, and comparison with the
        previous week. Reports its progress during the calculation. Changes nothing."""
        a_day = a_day_of_the_week or awa._today()
        monday = a_day - timedelta(days=a_day.weekday())
        with awa._open() as db:
            sales = awa.read_sales_of_the_week(db, awa._catalog(), a_day)
            orders = awa._orders(db)
        by_day, neighborhoods = [], {}
        for i in range(7):
            day = monday + timedelta(days=i)
            of_the_day = [o for o in orders if o.when.date() == day]
            for o in of_the_day:
                neighborhoods[o.neighborhood] = neighborhoods.get(o.neighborhood, 0) + o.total
            by_day.append(ReportDay(day=day.isoformat(), orders=len(of_the_day),
                                    total_fcfa=sum(o.total for o in of_the_day)))
            n = len(of_the_day)
            await ctx.report_progress(i + 1, total=8, message=f"{awa.day_in_full(day)}: {n} order{'s' if n > 1 else ''}")
        by_neighborhood = dict(sorted(neighborhoods.items(), key=lambda q: -q[1]))
        await ctx.report_progress(8, total=8, message="Report ready")
        best = max(by_day, key=lambda d: d.total_fcfa)
        summary = (f"{sales.summary} Best day: {awa.day_in_full(date.fromisoformat(best.day))}"
                   f" ({awa.fcfa(best.total_fcfa)}). Top neighborhood: "
                   f"{next(iter(by_neighborhood), '—')}.")
        return WeekReport(sales=sales, by_day=by_day, by_neighborhood=by_neighborhood, summary=summary)

    @server.custom_route("/login", methods=["GET", "POST"])
    async def login(request: Request):
        return await provider.login_page(request)

    @server.custom_route("/health", methods=["GET"])
    async def health(_: Request):
        # Never authenticated: say nothing here that is not public.
        return JSONResponse({"state": "ok", "version": awa.VERSION})

    server.provider = provider  # for the administration scripts and the tests
    return server


def security(public_url: str) -> TransportSecuritySettings:
    """The accepted host names: the public address's, and those added (a trial tunnel)."""
    hosts = [urlsplit(public_url).hostname] + [h.strip() for h in
                                               os.environ.get("COMPTOIR_EXTRA_HOSTS", "").split(",") if h.strip()]
    return TransportSecuritySettings(allowed_hosts=[f for h in hosts for f in (h, f"{h}:*")],
                                     allowed_origins=["https://claude.ai"])


class AccessLog:
    """One line per MCP request: the method, the protocol revision, the client. Never the token."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] != "/mcp":
            return await self.app(scope, receive, send)
        headers = {k.decode().lower(): v.decode(errors="replace") for k, v in scope["headers"]}
        status = {}

        async def forward(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        await self.app(scope, receive, forward)
        log.info("mcp %s %s protocol=%s client=%s -> %s", scope["method"], headers.get("mcp-method", "-"),
                 headers.get("mcp-protocol-version", "-"), headers.get("user-agent", "-")[:60], status.get("code"))


def application(public_url: str, authorization_path: str, password_hash: str):
    server = build(public_url, authorization_path, password_hash)
    # stateless_http: the clients of the 2025-11-25 revision (the Claude app, among others) have no
    # session either; those of the 2026-07-28 revision never have one.
    app = server.streamable_http_app(stateless_http=True, transport_security=security(public_url))
    app.state.server = server
    app.add_middleware(AccessLog)
    return app


def _from_the_environment():
    url = os.environ.get("COMPTOIR_PUBLIC_URL", "").strip()
    password_hash = os.environ.get("COMPTOIR_PASSWORD_HASH", "").strip()
    if not url or not password_hash:
        return None  # imported by the tests or by build_extension: nothing to serve
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    return application(url, os.environ.get("COMPTOIR_AUTHORIZATION", "customer_data/authorization.sqlite3"),
                       password_hash)


app = _from_the_environment()
