"""The server tools: definitions, resuming after a pause, sources, errors, files, cost."""

from types import SimpleNamespace

import pytest
from anthropic.types import Usage

from comptoir.costs import cost
from comptoir.server_tools import call, produced_files, sources, text, tool_errors, web_fetch, web_search


@pytest.fixture(autouse=True)
def log(tmp_path, monkeypatch):
    monkeypatch.setattr("comptoir.config.LOG", str(tmp_path / "calls.jsonl"))


def test_the_definitions():
    assert web_search()["type"] == "web_search_20250305"
    assert web_search(dynamic_filtering=True)["type"] == "web_search_20260209"
    assert web_search(domains=["gouv.bj"])["allowed_domains"] == ["gouv.bj"]
    assert web_search()["user_location"]["city"] == "Cotonou"
    assert "country" not in web_search()["user_location"]  # “BJ” rejected by the API (400)
    fetch = web_fetch(max_content_tokens=2000)
    assert fetch["type"] == "web_fetch_20250910" and fetch["max_content_tokens"] == 2000


def test_a_search_costs_one_cent_on_top_of_the_tokens():
    usage = Usage(input_tokens=10_000, output_tokens=500,
                  server_tool_use={"web_search_requests": 2, "web_fetch_requests": 0})
    price = cost("claude-sonnet-5-5", usage)
    assert price.searches == 2
    assert price.dollars == pytest.approx(10_000 * 2 / 1e6 + 500 * 10 / 1e6 + 2 * 0.01)


def message(stop_reason, *blocks, searches=0):
    return SimpleNamespace(content=list(blocks), stop_reason=stop_reason, _request_id="req",
                           usage=Usage(input_tokens=1000, output_tokens=100,
                                       server_tool_use={"web_search_requests": searches, "web_fetch_requests": 0}))


class FakeClient:
    def __init__(self, *responses):
        self.messages, self.responses, self.requests = self, list(responses), []

    def create(self, **request):
        self.requests.append(request)
        return self.responses.pop(0)


def test_a_pause_is_resumed_by_sending_the_response_back_as_is():
    pause = message("pause_turn", SimpleNamespace(type="server_tool_use", id="srv1"), searches=1)
    end = message("end_turn", SimpleNamespace(type="text", text="Here it is.", citations=None), searches=1)
    client = FakeClient(pause, end)
    request = {"model": "claude-sonnet-5-5", "max_tokens": 100, "tools": [web_search()],
               "messages": [{"role": "user", "content": "?"}]}
    result = call(client, request)
    assert result.text == "Here it is." and result.resumptions == 1 and result.searches == 2
    second = client.requests[1]
    assert second["messages"][-1] == {"role": "assistant", "content": pause.content}
    assert second["tools"] == request["tools"]  # the same tools, otherwise the API rejects the resumption


def test_the_sources_the_text_and_the_errors():
    citation = SimpleNamespace(type="web_search_result_location", url="https://example.bj/holidays", title="Public holidays")
    response = message(
        "end_turn",
        SimpleNamespace(type="text", text="November 1 ", citations=None),
        SimpleNamespace(type="text", text="is a public holiday.", citations=[citation, citation]),
        SimpleNamespace(type="web_search_tool_result",
                        content=SimpleNamespace(type="web_search_tool_result_error", error_code="max_uses_exceeded")),
    )
    assert text(response) == "November 1 is a public holiday."
    assert sources(response) == [{"source": "https://example.bj/holidays", "title": "Public holidays"}]
    assert tool_errors(response) == ["web_search_tool_result: max_uses_exceeded"]


def test_the_files_produced_by_the_code():
    output = SimpleNamespace(type="bash_code_execution_output", file_id="file_123")
    block = SimpleNamespace(type="bash_code_execution_tool_result",
                            content=SimpleNamespace(type="bash_code_execution_result", content=[output]))
    assert produced_files(message("end_turn", block)) == ["file_123"]
