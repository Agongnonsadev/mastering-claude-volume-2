"""What the SDK really does when a stream breaks, against a fake local server.

No call to the API: the SDK's client talks to a small server on 127.0.0.1, which
starts a streaming answer then cuts it in three ways. Enough to check, with
the installed version of the SDK, what comptoir.streaming.resumable must recognize.
"""

import asyncio
import json

import anthropic
import httpx2
from anthropic import AsyncAnthropic

from comptoir.streaming import resumable

START = [
    ("message_start", {"type": "message_start", "message": {
        "id": "msg_local", "type": "message", "role": "assistant", "model": "claude-sonnet-5-5",
        "content": [], "stop_reason": None, "stop_sequence": None,
        "usage": {"input_tokens": 10, "output_tokens": 1}}}),
    ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
    ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello, "}}),
]
OVERLOADED = ("error", {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})


def _chunk(name: str, data: dict) -> bytes:
    """An SSE event, in a “chunked” HTTP chunk, as the API sends it."""
    encoded = f"event: {name}\ndata: {json.dumps(data)}\n\n".encode()
    return f"{len(encoded):x}\r\n".encode() + encoded + b"\r\n"


def _server(ending: str):
    async def respond(reader, writer):
        headers = (await reader.readuntil(b"\r\n\r\n")).decode()
        length = next(int(l.split(":")[1]) for l in headers.split("\r\n") if l.lower().startswith("content-length"))
        await reader.readexactly(length)
        writer.write(
            b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n"
            b"request-id: req_local\r\ntransfer-encoding: chunked\r\n\r\n"
        )
        for name, data in START:
            writer.write(_chunk(name, data))
        if ending == "error":
            writer.write(_chunk(*OVERLOADED))
        if ending in ("error", "clean_close"):
            writer.write(b"0\r\n\r\n")  # normal end of the HTTP body
        # ending == "cut": the connection is closed without finishing the body, like a network that gives way
        await writer.drain()
        writer.close()

    return respond


def _try(ending: str):
    async def scenario():
        server = await asyncio.start_server(_server(ending), "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        client = AsyncAnthropic(api_key="fake-local-key", base_url=f"http://127.0.0.1:{port}", max_retries=0)
        received = []
        try:
            async with client.messages.stream(
                model="claude-sonnet-5-5", max_tokens=100, messages=[{"role": "user", "content": "Hello"}]
            ) as stream:
                async for text in stream.text_stream:
                    received.append(text)
                return received, await stream.get_final_message(), None
        except Exception as error:
            return received, None, error
        finally:
            server.close()
            await server.wait_closed()

    return asyncio.run(scenario())


def test_a_cut_connection_surfaces_as_a_transport_error():
    received, _, error = _try("cut")
    assert received == ["Hello, "]  # the beginning did arrive
    assert isinstance(error, httpx2.TransportError)
    assert not isinstance(error, anthropic.APIError)  # it is not an SDK error
    assert resumable(error)


def test_an_error_mid_stream_keeps_the_200_status():
    received, _, error = _try("error")
    assert received == ["Hello, "]
    assert isinstance(error, anthropic.APIStatusError) and error.status_code == 200
    assert error.body["error"]["type"] == "overloaded_error"
    assert resumable(error)


def test_a_stream_closed_without_message_stop_raises_no_error():
    received, message, error = _try("clean_close")
    assert error is None
    # The trap: a truncated message, without a stop reason. Hence the check of stop_reason.
    assert message.stop_reason is None
    assert [b.text for b in message.content] == ["Hello, "]
