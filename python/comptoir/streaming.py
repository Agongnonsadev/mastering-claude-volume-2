"""Stream an answer from Claude, keep it for whoever reads it, resume it if the stream breaks (chapter 6).

The generation is decoupled from the browser's connection: Claude writes into a
Generation, kept in memory; one or more connections read it. If the customer's
phone loses the network, the answer goes on being written, and the next connection
picks up at the chunk where the previous one had stopped.
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field

import anthropic
import httpx2  # the HTTP client on which the anthropic SDK relies

from comptoir.costs import Cost, cost
from comptoir.errors import diagnose, diagnose_stop
from comptoir.log import log_call

log = logging.getLogger("comptoir")

# Documented method for the 4.6 and later models: a new user message,
# which contains the partial answer and asks to continue.
RESUME_INSTRUCTION = (
    "Your previous response was interrupted. It ended like this:\n"
    "<interrupted_response>\n{partial}\n</interrupted_response>\n"
    "Continue exactly from where you left off, without repeating what came before."
)

# Transient error types that can arrive mid-stream, after the 200 status.
TRANSIENT_ERRORS = {"overloaded_error", "api_error"}


class IncompleteStream(Exception):
    """The stream closed without message_stop. The SDK then raises no error: it returns
    a truncated message, without a stop reason (checked by tests/test_ch06_cutoff.py)."""


def resumable(error: BaseException) -> bool:
    """A cut or an overload can be resumed; a rejected request (400, 401…) cannot."""
    if isinstance(error, IncompleteStream):
        return True
    if isinstance(error, anthropic.APIStatusError):
        if error.status_code >= 500:  # 500 internal error, 529 overloaded
            return True
        # An error that arrives mid-stream keeps the 200 status: its type is in the body.
        body = error.body if isinstance(error.body, dict) else {}
        return body.get("error", {}).get("type") in TRANSIENT_ERRORS
    # A connection that gives way mid-stream surfaces as a transport error of the
    # HTTP client, not as an SDK error (checked by tests/test_ch06_cutoff.py).
    return isinstance(error, (anthropic.APIConnectionError, httpx2.TransportError))


def resume_request(request: dict, partial: str) -> dict:
    """The request that asks Claude to finish a cut answer.

    A message is added without touching the previous ones: the beginning of the conversation stays
    identical, its cache and the preserved thinking remain valid. The message goes
    right after the customer's, before any instructions from Awa, because a mid-conversation system
    message must stay last or be followed by an answer.
    """
    messages = list(request["messages"])
    position = len(messages)
    while position and messages[position - 1]["role"] == "system":
        position -= 1
    messages.insert(position, {"role": "user", "content": RESUME_INSTRUCTION.format(partial=partial)})
    return {**request, "messages": messages}


@dataclass
class Generation:
    """An answer being written. Several connections can follow it;
    a cut connection picks it up at the index where it was."""

    conversation: str
    chunks: list[str] = field(default_factory=list)
    end: dict | None = None
    finished_at: float | None = None
    task: asyncio.Task | None = field(default=None, repr=False)
    _signal: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    @property
    def text(self) -> str:
        return "".join(self.chunks)

    def add(self, chunk: str) -> None:
        self.chunks.append(chunk)
        self._wake()

    def finish(self, event: dict) -> None:
        self.end = event
        self.finished_at = time.monotonic()
        self._wake()

    def _wake(self) -> None:
        signal, self._signal = self._signal, asyncio.Event()
        signal.set()

    async def follow(self, since: int = 0, max_silence: float = 15.0):
        """Yields ("text", index, chunk) from index `since`, then ("end", index, event).

        Yields ("silence", index, None) when nothing arrives for max_silence seconds:
        enough to send a sign of life, so that neither the browser nor a proxy
        mistakes the connection for dead.
        """
        index = since
        while True:
            signal = self._signal  # taken before reading: nothing can slip past us
            while index < len(self.chunks):
                yield "text", index, self.chunks[index]
                index += 1
            if self.end is not None:
                yield "end", index, self.end
                return
            try:
                await asyncio.wait_for(signal.wait(), max_silence)
            except asyncio.TimeoutError:
                yield "silence", index, None


@dataclass
class Result:
    message: object      # the last message received from the API
    cost: Cost           # its cost (that of a cut call is not known)
    resumed: bool        # True if the answer had to be resumed after a cut


async def _one_stream(client, request: dict, generation: Generation, prompt: str | None) -> tuple[object, Cost]:
    request_id, start = None, time.monotonic()
    try:
        async with client.messages.stream(**request) as stream:
            request_id = stream.request_id
            async for chunk in stream.text_stream:  # the text only, never the thinking
                generation.add(chunk)
            message = await stream.get_final_message()
        if message.stop_reason is None:
            raise IncompleteStream()
    except Exception as error:
        diagnosis = diagnose(error)
        log_call(request_id, request["model"], None, prompt=prompt, customer=generation.conversation,
                 error=diagnosis.code, origin=diagnosis.origin, duration_ms=_ms(start))
        raise
    price = cost(request["model"], message.usage)
    stop = diagnose_stop(message)
    log_call(request_id, request["model"], price, prompt=prompt, customer=generation.conversation,
             stop_reason=message.stop_reason, duration_ms=_ms(start),
             error=stop.code if stop else None, origin=stop.origin if stop else None)
    return message, price


def _ms(start: float) -> int:
    return round((time.monotonic() - start) * 1000)


async def stream_reply(client, request: dict, generation: Generation, prompt: str | None = None) -> Result:
    """Streams the answer into `generation`, with at most one resumption if the stream breaks.

    Only one: if the resumption breaks in turn, the error surfaces, and it is up to the interface
    to tell the customer rather than insisting.
    """
    try:
        message, price = await _one_stream(client, request, generation, prompt)
        return Result(message, price, resumed=False)
    except Exception as error:
        if not resumable(error):
            raise
        log.warning("Stream interrupted (%s), resuming after %d chunks", type(error).__name__, len(generation.chunks))

    partial = generation.text
    # Nothing received: the request is simply sent again. Otherwise, the rest is asked for.
    rest = resume_request(request, partial) if partial else request
    message, price = await _one_stream(client, rest, generation, prompt)
    return Result(message, price, resumed=bool(partial))
