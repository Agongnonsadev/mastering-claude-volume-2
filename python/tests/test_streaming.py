"""The Comptoir's streaming, with a fake client: resumption after a cut, nothing twice."""

import asyncio
import json

import anthropic
import httpx2
import pytest

from comptoir.streaming import Generation, IncompleteStream, resumable, resume_request, stream_reply
from fake_clients import FakeAsyncClient, FakeStream, final_message

REQUEST = {
    "model": "claude-sonnet-5-5",
    "max_tokens": 2000,
    "system": "prompt",
    "messages": [{"role": "user", "content": "<customer_message>\nYour juices?\n</customer_message>"}],
}


@pytest.fixture(autouse=True)
def temporary_log(tmp_path, monkeypatch):
    log = tmp_path / "calls.jsonl"
    monkeypatch.setattr("comptoir.config.LOG", str(log))
    return log


def _response(status: int, body: dict | None = None) -> httpx2.Response:
    return httpx2.Response(status, json=body, request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))


def test_the_resumption_adds_a_message_without_touching_the_previous_ones():
    rest = resume_request(REQUEST, "We have bissap, gin")
    assert rest["messages"][:1] == REQUEST["messages"]
    assert len(REQUEST["messages"]) == 1  # the original request has not moved
    assert rest["messages"][-1]["role"] == "user"
    assert "We have bissap, gin" in rest["messages"][-1]["content"]
    assert rest["system"] == REQUEST["system"]


def test_the_resumption_goes_before_awas_instructions():
    with_instruction = {**REQUEST, "messages": REQUEST["messages"] + [{"role": "system", "content": "Soursop out of stock."}]}
    roles = [m["role"] for m in resume_request(with_instruction, "start")["messages"]]
    # A system message must stay last or be followed by an answer.
    assert roles == ["user", "user", "system"]


def test_what_can_be_resumed_and_what_cannot():
    overloaded_mid_stream = anthropic.APIStatusError(
        "Overloaded",
        response=_response(200),
        body={"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}},
    )
    assert resumable(overloaded_mid_stream)
    assert resumable(httpx2.RemoteProtocolError("peer closed connection"))
    assert resumable(IncompleteStream())
    assert resumable(anthropic.InternalServerError("Error", response=_response(500), body=None))
    assert not resumable(anthropic.BadRequestError("Invalid request", response=_response(400), body=None))
    assert not resumable(anthropic.AuthenticationError("Invalid key", response=_response(401), body=None))


def test_a_connection_that_comes_back_resumes_at_the_right_chunk():
    async def scenario():
        generation = Generation("c1")
        for chunk in ("Hel", "lo", "!"):
            generation.add(chunk)
        generation.finish({"type": "end"})
        return [(n, i, v) async for n, i, v in generation.follow(since=1)]

    assert asyncio.run(scenario()) == [("text", 1, "lo"), ("text", 2, "!"), ("end", 3, {"type": "end"})]


def test_a_sign_of_life_when_nothing_arrives():
    async def scenario():
        generation = Generation("c1")
        reader = generation.follow(max_silence=0.01)
        first = await reader.__anext__()
        generation.add("Yes")
        generation.finish({"type": "end"})
        return [first] + [e async for e in reader]

    assert asyncio.run(scenario()) == [("silence", 0, None), ("text", 0, "Yes"), ("end", 1, {"type": "end"})]


def test_a_stream_without_incident(temporary_log):
    client = FakeAsyncClient(FakeStream(["Bissap, ", "ginger."]))
    generation = Generation("c1")
    result = asyncio.run(stream_reply(client, REQUEST, generation, "system-v1@test"))
    assert generation.text == "Bissap, ginger."
    assert not result.resumed
    assert len(client.requests) == 1
    line = json.loads(temporary_log.read_text(encoding="utf-8"))
    assert line["request"] == "req_test" and line["cost_dollars"] > 0


def test_a_cut_mid_stream_is_resumed_without_duplicates(temporary_log):
    cut = FakeStream(["We have ", "bissap", " and"], cut_at=2, error=httpx2.RemoteProtocolError("cut"))
    rest = FakeStream([" ginger."], message=final_message(" ginger."))
    client = FakeAsyncClient(cut, rest)
    generation = Generation("c1")
    result = asyncio.run(stream_reply(client, REQUEST, generation))
    assert result.resumed
    assert generation.text == "We have bissap ginger."
    # The second request contains the partial answer, not the whole first request twice.
    assert "We have bissap" in client.requests[1]["messages"][-1]["content"]
    lines = [json.loads(l) for l in temporary_log.read_text(encoding="utf-8").splitlines()]
    assert [l.get("interrupted", False) for l in lines] == [True, False]


def test_a_stream_closed_without_message_stop_is_resumed():
    truncated = FakeStream(["We have "], message=final_message("We have ", stop_reason=None))
    client = FakeAsyncClient(truncated, FakeStream(["bissap."]))
    generation = Generation("c1")
    assert asyncio.run(stream_reply(client, REQUEST, generation)).resumed
    assert generation.text == "We have bissap."


def test_an_error_before_the_first_chunk_sends_the_same_request_again():
    overloaded = anthropic.InternalServerError("Error", response=_response(500), body=None)
    client = FakeAsyncClient(FakeStream(["x"], cut_at=0, error=overloaded), FakeStream(["Hello."]))
    result = asyncio.run(stream_reply(client, REQUEST, Generation("c1")))
    assert not result.resumed
    assert client.requests[1] == REQUEST


def test_a_refused_request_is_not_resumed():
    refusal = anthropic.BadRequestError("Invalid request", response=_response(400), body=None)
    client = FakeAsyncClient(FakeStream(["x"], cut_at=0, error=refusal))
    with pytest.raises(anthropic.BadRequestError):
        asyncio.run(stream_reply(client, REQUEST, Generation("c1")))
    assert len(client.requests) == 1
