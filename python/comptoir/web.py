"""The Comptoir on the web (chapters 6 and 8): a page, a stream, kept conversations,
and a budget checked before each answer.

Chapter 18: limits per network address (comptoir/limits.py), a maximum request size,
a daily quota per address, and the deletion of old conversations once a day.

Run locally, from the python/ folder:
    python -m uvicorn comptoir.web:app --reload
then open http://127.0.0.1:8000
"""

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from importlib import resources

import anthropic
from anthropic import AsyncAnthropic
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationError

from comptoir import assistant, config
from comptoir.budget import Budget
from comptoir.call import COUNTING_FIELDS
from comptoir.conversations import Conversations
from comptoir.costs import cache_duration, max_cost
from comptoir.errors import REFUSAL, UNAVAILABLE, diagnose
from comptoir.limits import RateLimiter, client_address
from comptoir.log import log_event
from comptoir.prompt import SystemPrompt, load
from comptoir.streaming import Generation, stream_reply

log = logging.getLogger("comptoir")

KEEP_S = 600  # a finished answer stays 10 minutes in memory, for a connection that comes back
PURGE_S = 24 * 3600  # old conversations are deleted once a day (chapter 18)


class Message(BaseModel):
    conversation: str | None = None
    message_id: str = Field(min_length=8, max_length=64)  # created by the browser, one per message
    text: str = Field(min_length=1, max_length=2000)
    since: int = Field(default=0, ge=0)  # number of chunks already received (resumption)


class Busy(Exception):
    """An answer is already in progress in this conversation."""


class TooManyMessages(Exception):
    """A limit of the address is reached (chapter 18); `wait`: the seconds before trying again."""

    def __init__(self, reason: str, wait: float):
        super().__init__(reason)
        self.reason, self.wait = reason, wait


class Comptoir:
    """The server's state: the API client, the conversations, the answers in progress."""

    def __init__(self, client=None, conversations: Conversations | None = None, budget: Budget | None = None):
        self._client = client
        self._conversations = conversations
        self._budget = budget
        self.generations: dict[str, Generation] = {}
        self.messages_per_minute = RateLimiter(config.MESSAGES_PER_MINUTE_LIMIT, 60)
        self.conversations_per_hour = RateLimiter(config.CONVERSATIONS_PER_HOUR_LIMIT, 3600)

    # Created at first use: importing this module must neither read the key nor open the database.
    @property
    def client(self):
        if self._client is None:
            self._client = AsyncAnthropic(timeout=config.TIMEOUT_S, max_retries=config.RETRIES)
        return self._client

    @property
    def budget(self) -> Budget:
        if self._budget is None:
            self._budget = Budget(config.BUDGET_DB)
        return self._budget

    @property
    def conversations(self) -> Conversations:
        if self._conversations is None:
            self._conversations = Conversations(config.CONVERSATIONS)
        return self._conversations

    def _forget_old_ones(self) -> None:
        limit = time.monotonic() - KEEP_S
        for key in [k for k, g in self.generations.items() if g.finished_at and g.finished_at < limit]:
            del self.generations[key]

    def _limit(self, limiter: RateLimiter, reason: str, address: str) -> None:
        wait = limiter.accept(address)
        if wait is not None:
            log_event("limit", reason=reason, address=address)
            raise TooManyMessages(reason, wait)

    def launch(self, m: Message, address: str = "unknown") -> tuple[Generation, str | None]:
        """Returns the answer to follow, and the reason if the conversation had to be renewed."""
        self._forget_old_ones()

        # The same message, sent again after a cut: it is attached, Claude is not called again.
        existing = self.generations.get(m.message_id)
        if existing:
            if m.conversation not in (None, existing.conversation):
                raise Busy(m.conversation)  # an ID already taken elsewhere: refused
            return existing, None
        # A resumption does not count; a new message does (chapter 18).
        self._limit(self.messages_per_minute, "messages_per_minute", address)

        prompt = load()  # reread at each message: Awa may have changed her catalog
        conversation, reason = m.conversation, None
        if conversation and self.conversations.exists(conversation):
            reason = self.conversations.closing_reason(conversation, prompt.id)
        else:
            reason = "unknown" if conversation else None
        if not conversation or reason:
            self._limit(self.conversations_per_hour, "conversations_per_hour", address)
            conversation = self.conversations.create(prompt.id)

        # One answer at a time per conversation: otherwise two answers written without seeing each other
        # would enter the same history, and Claude would reread a past it never lived.
        if any(g.conversation == conversation and g.end is None for g in self.generations.values()):
            raise Busy(conversation)

        generation = Generation(conversation)
        self.generations[m.message_id] = generation
        generation.task = asyncio.create_task(self._produce(generation, m.text, prompt, address))
        return generation, reason

    async def _reserve(self, generation: Generation, request: dict, address: str = "unknown"):
        """Counts the input (free) and reserves the maximum cost. Returns (reservation, maximum) or None."""
        try:
            count = await self.client.messages.count_tokens(**{k: v for k, v in request.items() if k in COUNTING_FIELDS})
        except Exception as error:
            diagnostic = diagnose(error)
            log_event("counting_impossible", customer=generation.conversation, error=diagnostic.code,
                      origin=diagnostic.origin)
            generation.finish({"type": "error", "message": diagnostic.for_customer})
            return None
        maximum = max_cost(request["model"], count.input_tokens, request["max_tokens"], cache_duration(request))
        decision = self.budget.reserve(generation.conversation, maximum, group=f"address:{address}")
        if not decision.accepted:
            log_event("over_budget", reason=decision.reason, customer=generation.conversation)
            generation.finish({"type": "error", "message": UNAVAILABLE})
            return None
        if decision.alert:
            log.warning("Budget: alert threshold crossed (day $%.4f, month $%.4f)", self.budget.for_day(),
                        self.budget.for_month())
        return decision.reservation, maximum

    async def _produce(self, generation: Generation, text: str, prompt: SystemPrompt,
                       address: str = "unknown") -> None:
        history = self.conversations.history(generation.conversation)
        request = assistant.build_request(text, history=history, prompt=prompt)
        reserved = await self._reserve(generation, request, address)
        if reserved is None:
            return
        reservation, maximum = reserved
        try:
            result = await stream_reply(self.client, request, generation, prompt.id)
        except Exception as error:
            # Nothing is written to the history: the question can be asked again as is.
            diagnostic = diagnose(error)
            log.exception("Answer impossible (%s, origin: %s)", diagnostic.code, diagnostic.origin)
            # Refused by the API before writing anything: nothing is billed.
            if isinstance(error, anthropic.APIStatusError) and not generation.chunks:
                self.budget.release(reservation)
            generation.finish({"type": "error", "message": diagnostic.for_customer})
            return

        # After a resumption, the cost of the cut call is not known: the reserved maximum is kept.
        self.budget.settle(reservation, maximum if result.resumed else result.cost.dollars)
        message, usage = result.message, result.message.usage
        if message.stop_reason == "refusal":
            # The text already displayed is to be thrown away, and the turn does not enter the history.
            generation.finish({"type": "refusal", "message": REFUSAL})
            return
        # Normal case: the answer as is, thinking blocks included. After a resumption,
        # the full text, in a single block: the thinking of a cut stream cannot be stitched back.
        content = [{"type": "text", "text": generation.text}] if result.resumed else message.content
        question = request["messages"][len(history)]  # the customer's message, as sent
        tokens = (
            usage.input_tokens
            + (usage.cache_read_input_tokens or 0)
            + (usage.cache_creation_input_tokens or 0)
            + usage.output_tokens
        )
        self.conversations.add_turn(
            generation.conversation, [question, {"role": "assistant", "content": content}], tokens
        )
        log.info("Answer %s: %s", generation.conversation[:8], result.cost)
        # The cost stays on the server side (log): Awa's customer does not need to see it.
        generation.finish({"type": "end", "truncated": message.stop_reason == "max_tokens"})


def _sse_event(name: str, data: dict, event_id: int | None = None) -> str:
    """An SSE event. The data is in JSON: a line break in Claude's text
    therefore cannot break the format, where an empty line separates the events."""
    lines = [f"event: {name}"]
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append("data: " + json.dumps(data, ensure_ascii=False))
    return "\n".join(lines) + "\n\n"


async def _sse_stream(generation: Generation, reason: str | None, since: int):
    yield _sse_event("conversation", {"conversation": generation.conversation, "renewed": reason})
    async for kind, index, value in generation.follow(since):
        if kind == "text":
            yield _sse_event("text", {"text": value}, index)
        elif kind == "silence":
            yield ": alive\n\n"  # an SSE comment: ignored by the browser, but it goes through
        else:
            yield _sse_event(value["type"], value)


async def _purge_every_day(comptoir: Comptoir) -> None:
    """Chapter 18: the deletion promised in chapter 6, done for real, at startup then every day."""
    while True:
        try:
            deleted = comptoir.conversations.purge()
            log_event("purge", conversations=deleted)
        except Exception:
            log.exception("Purge of the conversations impossible")
        await asyncio.sleep(PURGE_S)


def _limit_refusal(limit: TooManyMessages) -> JSONResponse:
    return JSONResponse({"error": "Many messages in a short time: try again in a minute."},
                        status_code=429, headers={"Retry-After": str(int(limit.wait) + 1)})


class MaxBodySize:
    """Chapter 18: a body that is too big is refused (413). In front of the Comptoir, Caddy does the same (directive
    request_body, max_size); the check stays here, just in case.

    Fixed in chapter 19: reading the Content-Length header is not enough, because a body sent in chunks
    (Transfer-Encoding: chunked) has none. The bytes are therefore also counted as they arrive,
    and reading stops at the first byte too many. `maximum` gives the limit of a path, read at each
    request in comptoir/config.py."""

    def __init__(self, app, maximum=lambda path: config.MAX_REQUEST_SIZE):
        self.app, self.maximum = app, maximum

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        maximum = self.maximum(scope["path"])
        length = dict(scope["headers"]).get(b"content-length", b"")
        if length.isdigit() and int(length) > maximum:
            return await JSONResponse({"error": "Message too long."}, status_code=413)(scope, receive, send)
        received = 0

        async def counting_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > maximum:
                    raise HTTPException(status_code=413, detail="Message too long.")
            return message

        await self.app(scope, counting_receive, send)


def create_app(client=None, conversations: Conversations | None = None, budget: Budget | None = None) -> FastAPI:
    comptoir = Comptoir(client, conversations, budget)

    @asynccontextmanager
    async def lifespan(_app):
        task = asyncio.create_task(_purge_every_day(comptoir))
        try:
            yield
        finally:
            task.cancel()

    app = FastAPI(title="Awa's Comptoir", lifespan=lifespan)
    app.state.comptoir = comptoir
    app.add_middleware(MaxBodySize)

    @app.get("/", response_class=HTMLResponse)
    def page() -> str:
        return resources.files("comptoir").joinpath("pages/comptoir.html").read_text(encoding="utf-8")

    @app.post("/api/messages")
    async def messages(m: Message, request: Request):
        address = client_address(request.client.host if request.client else None,
                                 request.headers.get("x-forwarded-for"), config.TRUSTED_PROXIES)
        try:
            generation, reason = comptoir.launch(m, address)
        except Busy:
            return JSONResponse({"error": "An answer is already in progress."}, status_code=409)
        except TooManyMessages as limit:
            return _limit_refusal(limit)
        return StreamingResponse(
            _sse_stream(generation, reason, m.since),
            media_type="text/event-stream",
            # no-cache: nothing must keep this stream; X-Accel-Buffering: asks an nginx
            # proxy to pass on each chunk without waiting to have a full buffer.
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.websocket("/ws")
    async def websocket(socket: WebSocket):
        """The same conversation over WebSocket: a connection open in both directions."""
        await socket.accept()
        address = client_address(socket.client.host if socket.client else None,
                                 socket.headers.get("x-forwarded-for"), config.TRUSTED_PROXIES)
        try:
            while True:
                try:
                    m = Message.model_validate(await socket.receive_json())
                    generation, reason = comptoir.launch(m, address)
                except (ValidationError, Busy, TooManyMessages):
                    await socket.send_json({"type": "error", "message": "Message refused or answer already in progress."})
                    continue
                await socket.send_json(
                    {"type": "conversation", "conversation": generation.conversation, "renewed": reason}
                )
                async for kind, index, value in generation.follow(m.since):
                    if kind == "text":
                        await socket.send_json({"type": "text", "index": index, "text": value})
                    elif kind == "silence":
                        await socket.send_json({"type": "alive"})
                    else:
                        await socket.send_json(value)
        except WebSocketDisconnect:
            pass  # the answer goes on being written; a new connection will pick it up

    return app


app = create_app()
