"""Chapter 15: the “Comptoir for Awa” MCP server. No call to the API, no network, no Node."""

import asyncio
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone

import pytest

pytest.importorskip("mcp")  # the [mcp] extra: pip install -e ".[tests,mcp]"

from mcp import Client, StdioServerParameters

from ch14.make_orders import simulate
from ch15 import comptoir_for_awa as awa
from ch15.build_extension import SETTINGS, _inventory, manifest

T0 = datetime(2026, 10, 21, 7, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="module")
def model_database(tmp_path_factory):
    path = tmp_path_factory.mktemp("ch15") / "shop.sqlite3"
    simulate(path)
    return path


@pytest.fixture
def db(model_database, tmp_path, monkeypatch):
    """A fresh copy of the shop for each test: the corrections write to it."""
    copy = tmp_path / "shop.sqlite3"
    copy.write_bytes(model_database.read_bytes())
    monkeypatch.setenv("COMPTOIR_SHOP", str(copy))
    monkeypatch.setenv("COMPTOIR_TODAY", "2026-10-17")
    monkeypatch.setattr(awa, "_now", lambda: T0)
    return copy


def call(tool: str, arguments: dict | None = None):
    async def _():
        async with Client(awa.server, raise_exceptions=True) as client:
            return await client.call_tool(tool, arguments or {})
    return asyncio.run(_())


def test_the_server_announces_five_tools_only_one_destructive():
    async def _():
        async with Client(awa.server) as client:
            return (await client.list_tools()).tools
    tools = {t.name: t for t in asyncio.run(_())}
    assert set(tools) == {"orders_of_the_day", "stock", "sales_of_the_week", "prepare_correction",
                          "apply_correction"}
    destructive = [n for n, t in tools.items() if t.annotations.destructive_hint]
    assert destructive == ["apply_correction"]
    assert tools["apply_correction"].meta == {"anthropic/requiresUserInteraction": True}
    assert all(tools[n].annotations.read_only_hint for n in ("orders_of_the_day", "stock", "sales_of_the_week"))
    assert tools["prepare_correction"].annotations.read_only_hint is False  # it writes a draft, not the stock


def test_the_orders_of_the_day_are_those_of_the_database(db):
    result = call("orders_of_the_day").structured_content
    with sqlite3.connect(db) as connection:
        expected = connection.execute(
            "SELECT COUNT(*), SUM(total) FROM orders WHERE substr(created_at, 1, 10) = '2026-10-17'").fetchone()
    assert (result["count"], result["total_fcfa"]) == expected
    assert result["summary"] == f"{expected[0]} orders on Saturday, October 17, 2026, for {awa.fcfa(expected[1])}."
    # First name and initial only: enough to deliver, without the full name.
    assert all(len(o["customer"].split()) == 2 and o["customer"].endswith(".") for o in result["orders"])


def test_the_stock_flags_the_shortage(db):
    result = call("stock").structured_content
    soursop = next(p for p in result["products"] if p["product"] == "Soursop juice")
    assert soursop["state"] == "out_of_stock" and "Out of stock: Soursop juice." in result["summary"]


def test_the_sales_of_the_week_go_from_monday_to_sunday(db):
    result = call("sales_of_the_week", {"a_day_of_the_week": "2026-10-14"}).structured_content
    assert (result["start"], result["end"]) == ("2026-10-12", "2026-10-18")
    bissap = next(p for p in result["by_product"] if p["product"] == "Bissap juice")
    assert bissap["quantity"] == 129  # the figure checked in chapter 14


def test_a_correction_happens_in_two_steps(db):
    draft = call("prepare_correction", {"product": "Bissap juice", "counted_quantity": 32}).structured_content
    assert (draft["current_stock"], draft["difference"]) == (40, -8)
    assert "that is 8 fewer" in draft["to_tell_awa"]
    with sqlite3.connect(db) as connection:
        assert connection.execute(
            "SELECT quantity FROM stock WHERE product = 'Bissap juice'").fetchone() == (40,)  # unchanged
    done = call("apply_correction", {"token": draft["token"]}).structured_content
    assert (done["before"], done["after"]) == (40, 32)
    with sqlite3.connect(db) as connection:
        assert connection.execute("SELECT quantity FROM stock WHERE product = 'Bissap juice'").fetchone() == (32,)
        assert connection.execute("SELECT status FROM stock_corrections").fetchall() == [("applied",)]
    # A token can be used only once.
    again = call("apply_correction", {"token": draft["token"]})
    assert again.is_error and "already been used" in again.content[0].text


def test_a_token_expires_after_ten_minutes(db, monkeypatch):
    draft = call("prepare_correction", {"product": "Pineapple juice", "counted_quantity": 10}).structured_content
    monkeypatch.setattr(awa, "_now", lambda: T0 + timedelta(minutes=11))
    result = call("apply_correction", {"token": draft["token"]})
    assert result.is_error and "expired" in result.content[0].text
    with sqlite3.connect(db) as connection:
        assert connection.execute("SELECT quantity FROM stock WHERE product = 'Pineapple juice'").fetchone() == (12,)


def test_a_stock_that_moved_in_the_meantime_cancels_the_correction(db):
    draft = call("prepare_correction", {"product": "Bissap juice", "counted_quantity": 32}).structured_content
    with sqlite3.connect(db) as connection:
        connection.execute("UPDATE stock SET quantity = 37 WHERE product = 'Bissap juice'")  # a sale meanwhile
    result = call("apply_correction", {"token": draft["token"]})
    assert result.is_error and "has changed since the preparation (40 → 37" in result.content[0].text
    with sqlite3.connect(db) as connection:
        assert connection.execute("SELECT quantity FROM stock WHERE product = 'Bissap juice'").fetchone() == (37,)


def test_the_arguments_are_checked_before_the_code(db):
    assert call("prepare_correction", {"product": "Mango juice", "counted_quantity": 3}).is_error
    assert call("prepare_correction", {"product": "Bissap juice", "counted_quantity": -1}).is_error
    too_much = call("prepare_correction", {"product": "Bissap juice", "counted_quantity": 900})
    assert too_much.is_error and "too much for an inventory correction" in too_much.content[0].text


def test_a_missing_database_gives_a_message_that_says_what_to_do(monkeypatch, tmp_path):
    monkeypatch.setenv("COMPTOIR_SHOP", str(tmp_path / "missing.sqlite3"))
    result = call("stock")
    assert result.is_error and "Check the extension's “Shop database” setting" in result.content[0].text


def test_resources_and_prompts(db):
    async def _():
        async with Client(awa.server, raise_exceptions=True) as client:
            catalog = (await client.read_resource("comptoir://catalog")).contents[0].text
            order = (await client.read_resource("comptoir://order/C-0042")).contents[0].text
            templates = [t.uri_template for t in (await client.list_resource_templates()).resource_templates]
            review = await client.get_prompt("evening_review", {"day": "Saturday, October 17"})
            return catalog, order, templates, review
    catalog, order, templates, review = asyncio.run(_())
    assert "- Bissap juice (500 ml bottle): 1,000 FCFA" in catalog
    assert order.startswith("# Order C-0042") and templates == ["comptoir://order/{number}"]
    text = review.messages[0].content.text
    assert review.messages[0].role == "user" and "for Saturday, October 17" in text and "Do not change anything" in text


def test_the_server_starts_over_stdio_and_writes_nothing_on_standard_output(db):
    # The client reads standard output as JSON-RPC: a print() would break it.
    parameters = StdioServerParameters(command=sys.executable, args=[awa.__file__],
                                       env={"COMPTOIR_SHOP": str(db), "COMPTOIR_TODAY": "2026-10-17"})

    async def _():
        async with Client(parameters, read_timeout_seconds=60) as client:
            return client.protocol_version, (await client.call_tool("stock", {})).structured_content["summary"]
    version, summary = asyncio.run(_())
    assert version == "2026-07-28" and summary.startswith("Out of stock")


def test_the_manifest_announces_exactly_what_the_server_exposes():
    tools, prompts = asyncio.run(_inventory())
    m = manifest(tools, prompts)
    assert m["manifest_version"] == "0.4" and m["server"]["type"] == "uv"
    assert [t["name"] for t in m["tools"]] == ["orders_of_the_day", "stock", "sales_of_the_week",
                                               "prepare_correction", "apply_correction"]
    review = next(p for p in m["prompts"] if p["name"] == "evening_review")
    assert review["arguments"] == ["day"] and "${arguments.day}" in review["text"]
    # Each setting is passed on to the server, and only through the environment.
    assert m["server"]["mcp_config"]["env"] == {"COMPTOIR_SHOP": "${user_config.shop_database}"}
    assert set(m["user_config"]) == set(SETTINGS)


def test_formatting_for_awa():
    assert awa.fcfa(329500) == "329,500 FCFA"
    assert awa.day_in_full(date(2026, 11, 1)) == "Sunday, November 1, 2026"
    assert awa.discreet_customer("Larissa Noudéhou") == "Larissa N."
