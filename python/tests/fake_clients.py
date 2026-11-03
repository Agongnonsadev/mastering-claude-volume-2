"""A fake asynchronous client that streams: enough to test chapter 6 without a paid call."""

import asyncio
from types import SimpleNamespace

from anthropic.types import TextBlock, ThinkingBlock, Usage


def final_message(text: str, thinking: bool = True, stop_reason: str | None = "end_turn"):
    """A final message as the SDK returns it: a thinking block (display omitted) then the text."""
    blocks = [ThinkingBlock(type="thinking", thinking="", signature="test-signature")] if thinking else []
    blocks.append(TextBlock(type="text", text=text))
    return SimpleNamespace(
        content=blocks,
        stop_reason=stop_reason,
        usage=Usage(input_tokens=1000, output_tokens=50),
    )


class FakeStream:
    """Returns the chunks one by one; raises `error` before the chunk of rank `cut_at`."""

    def __init__(self, chunks, message=None, cut_at=None, error=None, delay=0.0):
        self.chunks = chunks
        self.message = message or final_message("".join(chunks))
        self.cut_at, self.error, self.delay = cut_at, error, delay
        self.request_id = "req_test"

    async def __aenter__(self):
        if self.cut_at == 0 and self.error is not None:
            raise self.error  # failure before the first chunk
        return self

    async def __aexit__(self, *exc):
        return False

    @property
    def text_stream(self):
        return self._text()

    async def _text(self):
        for rank, chunk in enumerate(self.chunks):
            if rank == self.cut_at:
                raise self.error
            await asyncio.sleep(self.delay)
            yield chunk

    async def get_final_message(self):
        return self.message


class FakeAsyncClient:
    """Each call to messages.stream() consumes the next stream of the list."""

    def __init__(self, *streams):
        self.messages = self
        self.streams = list(streams)
        self.requests = []

    def stream(self, **request):
        self.requests.append(request)
        return self.streams.pop(0)

    async def count_tokens(self, **request):  # chapter 8: the budget counts the input before calling
        self.counts = getattr(self, "counts", 0) + 1
        return SimpleNamespace(input_tokens=1000)
