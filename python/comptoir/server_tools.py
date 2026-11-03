"""The tools Anthropic runs for you: web search, page reading, code execution (chapter 10).

You declare them in the request; the API runs them during the request and puts their
results in the response. Your code runs nothing, but it reads everything: the sources
cited, the errors (which arrive in a 200 response), the files produced, the cost.
"""

from dataclasses import dataclass, field

from comptoir.costs import Cost, cost
from comptoir.log import log_call

# Searches start from Cotonou: local results come first. Without the country:
# on October 20, 2026, the API rejected the code “BJ” (“Country code BJ is not supported”, 400).
COTONOU_LOCATION = {"type": "approximate", "city": "Cotonou", "timezone": "Africa/Porto-Novo"}


def web_search(max_uses: int = 3, domains: list[str] | None = None, dynamic_filtering: bool = False) -> dict:
    """Dynamic filtering (versions 20260209 and later) has code sort the results before
    they enter the context: fewer tokens, but no more ZDR by default."""
    tool = {
        "type": "web_search_20260209" if dynamic_filtering else "web_search_20250305",
        "name": "web_search",
        "max_uses": max_uses,
        "user_location": COTONOU_LOCATION,
    }
    if domains:
        tool["allowed_domains"] = domains
    return tool


def web_fetch(max_uses: int = 2, max_content_tokens: int = 8000, citations: bool = True,
              domains: list[str] | None = None) -> dict:
    """max_content_tokens bounds what a page costs: an average page already weighs 2,500 tokens."""
    tool = {
        "type": "web_fetch_20250910",
        "name": "web_fetch",
        "max_uses": max_uses,
        "max_content_tokens": max_content_tokens,
        "citations": {"enabled": citations},
    }
    if domains:
        tool["allowed_domains"] = domains
    return tool


CODE_EXECUTION = {"type": "code_execution_20250825", "name": "code_execution"}


@dataclass
class Result:
    message: object                 # the last message
    text: str
    cost: float                     # in dollars, all the calls of the request, searches included
    calls: int
    searches: int
    resumptions: int                # number of pause_turn handled
    messages: list[object] = field(default_factory=list)


def call(client, request: dict, max_resumptions: int = 3, prompt: str | None = None) -> Result:
    """A call with server tools, resuming the pauses (pause_turn) up to max_resumptions times.

    A pause is not an error: the server-side tool loop paused. We send the response
    back as is, with the same tools, and Claude continues.
    """
    messages = list(request["messages"])
    total, searches, received = 0.0, 0, []
    for resumption in range(max_resumptions + 1):
        message = client.messages.create(**{**request, "messages": messages})
        price: Cost = cost(request["model"], message.usage)
        log_call(message._request_id, request["model"], price, prompt=prompt, stop_reason=message.stop_reason)
        total += price.dollars
        searches += price.searches
        received.append(message)
        if message.stop_reason != "pause_turn":
            return Result(message, text(message), total, len(received), searches, resumption, received)
        messages = messages + [{"role": "assistant", "content": message.content}]
    raise RuntimeError(f"Still paused after {max_resumptions} resumptions: run it again later or lower max_uses.")


def text(message) -> str:
    """The text of the response. With citations, it arrives in several blocks, to be joined."""
    return "".join(block.text for block in message.content if block.type == "text")


def sources(message) -> list[dict]:
    """The sources cited, without duplicates, in order of appearance. To show the reader."""
    seen, found = set(), []
    for block in message.content:
        for citation in getattr(block, "citations", None) or []:
            key = getattr(citation, "url", None) or getattr(citation, "document_title", None)
            if key and key not in seen:
                seen.add(key)
                found.append({"source": key, "title": getattr(citation, "title", None) or getattr(citation, "document_title", None)})
    return found


def tool_errors(message) -> list[str]:
    """The errors of the server tools. They interrupt nothing: they arrive in a 200 response."""
    errors = []
    for block in message.content:
        if not block.type.endswith("_tool_result"):
            continue
        content = getattr(block, "content", None)
        code = getattr(content, "error_code", None)
        if code:
            errors.append(f"{block.type}: {code}")
    return errors


def produced_files(message) -> list[str]:
    """The IDs of the files created by code execution, to download through the Files API."""
    ids = []
    for block in message.content:
        if block.type != "bash_code_execution_tool_result":
            continue
        result = block.content
        if getattr(result, "type", None) == "bash_code_execution_result":
            ids += [output.file_id for output in result.content if getattr(output, "file_id", None)]
    return ids
