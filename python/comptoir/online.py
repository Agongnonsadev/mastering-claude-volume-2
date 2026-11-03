"""The Comptoir online (chapter 19): the web chat and WhatsApp, on the shipped Comptoir.

    python -m uvicorn comptoir.online:app --port 8019          (locally, from the python/ folder)

What changes compared with the chat of chapter 6 (comptoir/web.py, kept for its streaming example):
- both channels go through the routed Comptoir, with its tools, its confirmation by code and its
  guards (comptoir/service.py); the answer arrives in one block, not word by word, because the tool loop
  must finish before we know what was done;
- one message at a time for the whole server (a single thread for the Comptoir); the databases are read and
  written only in that thread, purge and deduplication included: two threads on the same SQLite connection
  mix their transactions and their row counters (an unstable test showed it);
- WhatsApp: webhook verified and signed, answer through Meta's API, number kept in the directory only;
- the dashboard (/dashboard, with a token) and the health of the service (/health);
- the monitoring of chapter 18, if it is turned on, alongside the answer;
- the limits and the purge of chapter 18, for both channels.
"""

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from importlib import resources

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, StreamingResponse

from comptoir import config, dashboard, whatsapp
from comptoir.budget import Budget
from comptoir.conversations import Conversations
from comptoir.errors import UNAVAILABLE
from comptoir.limits import RateLimiter, client_address
from comptoir.log import log_event
from comptoir.monitoring import monitor
from comptoir.service import ComptoirService
from comptoir.shop import Shop
from comptoir.streaming import Generation
from comptoir.web import KEEP_S, MaxBodySize, Message, TooManyMessages, _limit_refusal, _sse_stream

log = logging.getLogger("comptoir")
PURGE_S = 24 * 3600


class Online:
    """The server's state: the service, the channels, the limits, the answers in progress on the web."""

    def __init__(self, client=None, shop=None, budget=None, conversations=None, knowledge=None, directory=None,
                 sender=None, **options):
        self._client, self._shop, self._budget = client, shop, budget
        self._conversations, self._knowledge, self._directory, self._sender = conversations, knowledge, directory, sender
        self.options = options
        self._service = None
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="comptoir")       # the Comptoir
        self.monitoring_worker = ThreadPoolExecutor(max_workers=2, thread_name_prefix="monitoring")
        self.generations: dict[str, Generation] = {}
        self.messages_per_minute = RateLimiter(config.MESSAGES_PER_MINUTE_LIMIT, 60)
        self.conversations_per_hour = RateLimiter(config.CONVERSATIONS_PER_HOUR_LIMIT, 3600)

    # Created at first use: importing this module reads neither the key nor the databases.
    @property
    def client(self):
        if self._client is None:
            import anthropic
            self._client = anthropic.Anthropic(timeout=config.TIMEOUT_S, max_retries=config.RETRIES)
        return self._client

    @property
    def service(self) -> ComptoirService:
        if self._service is None:
            from comptoir.knowledge import load_knowledge
            self._service = ComptoirService(
                self.client, self._shop or Shop(config.SHOP), self._budget or Budget(config.BUDGET_DB),
                self._conversations or Conversations(config.CONVERSATIONS),
                self._knowledge if self._knowledge is not None else load_knowledge(), **self.options)
        return self._service

    @property
    def directory(self) -> whatsapp.Directory:
        if self._directory is None:
            self._directory = whatsapp.Directory(config.CONVERSATIONS)
        return self._directory

    @property
    def sender(self) -> whatsapp.Sender:
        if self._sender is None:
            self._sender = whatsapp.Sender(config.WHATSAPP_TOKEN, config.WHATSAPP_API_VERSION)
        return self._sender

    def limit(self, limiter: RateLimiter, reason: str, key: str) -> None:
        wait = limiter.accept(key)
        if wait is not None:
            log_event("limit", reason=reason, address=key)
            raise TooManyMessages(reason, wait)

    def monitor(self, text: str, conversation: str, channel: str, group: str | None = None) -> None:
        if config.MONITORING_FILTER:
            self.monitoring_worker.submit(self._monitor, text, conversation, channel, group)

    def _monitor(self, text: str, conversation: str, channel: str, group: str | None) -> None:
        """In the monitoring thread: the call to Claude. The spending, for its part, is counted in the
        Comptoir's thread, like everything that touches the databases (chapter 20)."""
        _, dollars = monitor(self.client, text, conversation, channel)
        if dollars:
            try:
                self.worker.submit(self._count_monitoring, conversation, group, dollars, channel)
            except RuntimeError:  # the server is stopping: the call stays in the log, with its cost
                pass

    def _count_monitoring(self, conversation: str, group: str | None, dollars: float, channel: str) -> None:
        try:
            self.service.budget.add(conversation, dollars, group)
        except Exception as error:
            # In the thread, an exception surfaces nowhere: it is logged (Claude's review, chapter 20).
            log_event("monitoring_impossible", conversation=conversation, channel=channel,
                      error=type(error).__name__, cost_dollars=round(dollars, 6))
            return
        log_event("monitoring", conversation=conversation, channel=channel, cost_dollars=round(dollars, 6))

    # --- The web chat ------------------------------------------------------------------------------

    async def launch_web(self, m: Message, address: str) -> tuple[Generation, str | None]:
        limit = time.monotonic() - KEEP_S
        for key in [k for k, g in self.generations.items() if g.finished_at and g.finished_at < limit]:
            del self.generations[key]
        already = self.generations.get(m.message_id)
        if already:  # the same message, sent again after a cut: it is reattached
            return already, None
        self.limit(self.messages_per_minute, "messages_per_minute", address)
        conversation, reason = await asyncio.get_running_loop().run_in_executor(
            self.worker, self._open_web, m.conversation, address)
        already = self.generations.get(m.message_id)
        if already:  # arrived twice during the wait: it is reattached to the first one
            return already, None
        generation = Generation(conversation)
        self.generations[m.message_id] = generation
        generation.task = asyncio.create_task(self._produce_web(generation, m.text, address))
        return generation, reason

    def _open_web(self, conversation: str | None, address: str) -> tuple[str, str | None]:
        """In the Comptoir's thread: does the conversation exist, open one, count the new ones."""
        if not conversation or not self.service.conversations.exists(conversation):
            self.limit(self.conversations_per_hour, "conversations_per_hour", address)
        conversation, reason, _ = self.service.open(conversation)
        return conversation, reason

    async def _produce_web(self, generation: Generation, text: str, address: str) -> None:
        self.monitor(text, generation.conversation, "web", f"address:{address}")
        try:
            turn = await asyncio.get_running_loop().run_in_executor(
                self.worker, self.service.answer, generation.conversation, text, "web", f"address:{address}")
        except Exception:
            log.exception("Answer impossible")
            generation.finish({"type": "error", "message": UNAVAILABLE})
            return
        generation.add(turn.text)
        generation.finish({"type": "end", "truncated": False})

    # --- WhatsApp ---------------------------------------------------------------------------------

    def handle_whatsapp(self, message: whatsapp.IncomingMessage) -> None:
        """In the Comptoir's thread: one answer per message, sent through Meta's API."""
        try:
            self._handle_whatsapp(message)
        except Exception as error:
            # An exception in the thread surfaces nowhere: without this trace, the customer would wait in silence.
            log.exception("WhatsApp message not handled")
            log_event("whatsapp_processing", error=type(error).__name__)

    def _handle_whatsapp(self, message: whatsapp.IncomingMessage) -> None:
        if not self.directory.new(message.id):  # Meta retries: a message is handled only once
            return
        pseudo = whatsapp.pseudonym(message.number, config.PSEUDONYM_SALT)
        try:
            self.limit(self.messages_per_minute, "messages_per_minute", pseudo)
        except TooManyMessages:
            return  # a script, not a customer: no answer, no cost
        conversation, _, new = self.service.open(self.directory.conversation(pseudo))
        self.directory.link(pseudo, message.number, conversation)
        if message.type != "text" or not message.text:
            text = whatsapp.NOT_TEXT
        else:
            self.monitor(message.text, conversation, "whatsapp", pseudo)
            text = self.service.answer(conversation, message.text, "whatsapp", group=pseudo).text
        if new:
            text = f"{whatsapp.AI_DISCLOSURE}\n\n{text}"
        try:
            self.sender.send(message.business_number, message.number, text)
            log_event("whatsapp_send", conversation=conversation)
        except Exception as error:
            log_event("whatsapp_send", conversation=conversation, error=type(error).__name__,
                      status=getattr(getattr(error, "response", None), "status_code", None))

    def purge(self) -> dict:
        result = self.service.shop.purge(config.REQUEST_RETENTION_DAYS, config.NAME_RETENTION_DAYS,
                                         config.SUMMARY_RETENTION_DAYS)
        result["conversations"] = self.service.conversations.purge()
        result["whatsapp_customers"] = self.directory.purge(config.RETENTION_DAYS)
        return result


def _valid_token(request: Request) -> bool:
    return bool(config.DASHBOARD_TOKEN) and request.headers.get("authorization") == f"Bearer {config.DASHBOARD_TOKEN}"


def create_app(**settings) -> FastAPI:
    state = Online(**settings)

    async def purge_every_day() -> None:
        while True:
            try:
                log_event("purge", **await asyncio.get_running_loop().run_in_executor(state.worker, state.purge))
            except Exception:
                log.exception("Purge impossible")
            await asyncio.sleep(PURGE_S)

    @asynccontextmanager
    async def lifespan(_app):
        task = asyncio.create_task(purge_every_day())
        try:
            yield
        finally:
            task.cancel()
            # The queued messages are finished before stopping: Meta has already received its 200 and will not send them again.
            # (compose.yaml gives the container 30 seconds to stop.) The monitoring, for its part, can wait.
            state.worker.shutdown(wait=True)
            state.monitoring_worker.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="Awa's Comptoir, online", lifespan=lifespan)
    app.state.state = state

    # Chapter 18: a body that is too big is refused, even sent in chunks. WhatsApp has its own limit:
    # Meta sends notifications of up to 3 MB.
    app.add_middleware(MaxBodySize, maximum=lambda path: (
        config.MAX_WEBHOOK_SIZE if path == "/whatsapp" else config.MAX_REQUEST_SIZE))

    @app.get("/", response_class=HTMLResponse)
    def page() -> str:
        return resources.files("comptoir").joinpath("pages/comptoir.html").read_text(encoding="utf-8")

    @app.post("/api/messages")
    async def messages(m: Message, request: Request):
        address = client_address(request.client.host if request.client else None,
                                 request.headers.get("x-forwarded-for"), config.TRUSTED_PROXIES)
        try:
            generation, reason = await state.launch_web(m, address)
        except TooManyMessages as limit:
            return _limit_refusal(limit)
        return StreamingResponse(_sse_stream(generation, reason, m.since), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/whatsapp")
    def verify_webhook(request: Request):
        """Meta's verification: return hub.challenge if the token is the right one."""
        p = request.query_params
        if (config.WHATSAPP_VERIFY_TOKEN and p.get("hub.mode") == "subscribe"
                and p.get("hub.verify_token") == config.WHATSAPP_VERIFY_TOKEN):
            return PlainTextResponse(p.get("hub.challenge", ""))
        return PlainTextResponse("Refused", status_code=403)

    @app.post("/whatsapp")
    async def receive(request: Request):
        body = await request.body()
        if not whatsapp.valid_signature(body, request.headers.get("x-hub-signature-256"), config.WHATSAPP_APP_SECRET):
            log_event("whatsapp_invalid_signature")
            return PlainTextResponse("Invalid signature", status_code=401)
        if not config.PSEUDONYM_SALT:
            # Without a salt, a number's fingerprint is found by trying all the possible numbers: nothing is
            # handled. Meta, which receives 503, sends the notification again for 7 days (chapter 20).
            log_event("whatsapp_not_configured", missing="COMPTOIR_PSEUDONYM_SALT")
            return PlainTextResponse("WhatsApp is not configured yet", status_code=503)
        try:
            incoming = whatsapp.incoming_messages(await request.json())
        except ValueError:
            return PlainTextResponse("Unreadable body", status_code=400)
        for message in incoming:
            # Entrusted to the Comptoir's thread, without waiting for it: Meta receives its 200 right away. The duplicate
            # is set aside in the thread, like everything that touches the databases.
            state.worker.submit(state.handle_whatsapp, message)  # duplicates set aside in the worker
        return PlainTextResponse("ok")

    @app.get("/dashboard", response_class=HTMLResponse)
    def show_dashboard(request: Request):
        if not _valid_token(request):
            return PlainTextResponse("Restricted access", status_code=401)
        return dashboard.to_html(dashboard.load())

    @app.get("/health")
    def health():
        return {"state": "ok"}

    return app


app = create_app()
