"""Chapter 21: the watch over the models and the SDK, the estimate of a project. No call to the API."""

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from ch18 import data
from ch21 import watch
from comptoir import whatsapp
from comptoir.conversations import Conversations
from comptoir.shop import Shop

NOW = datetime(2026, 10, 22, tzinfo=timezone.utc)
# Three lines of the “Model status” table of the deprecations page, as read on October 22, 2026.
PAGE = """| API model name             | Current state | Deprecated         | Tentative retirement date          |
| :------------------------- | :------------ | :----------------- | :--------------------------------- |
| claude-sonnet-5-5          | Active        | N/A                | Not sooner than September 28, 2027 |
| claude-sonnet-4-5-20250929 | Deprecated    | September 30, 2026 | November 30, 2026                  |
| claude-haiku-4-5-20251001  | Active        | N/A                | Not sooner than October 15, 2026   |
"""


def model(model_id, lifecycle="active", retirement=None):
    return SimpleNamespace(id=model_id, lifecycle=lifecycle, retires_at=retirement)


def test_the_deprecations_page_reads_as_states_and_dates():
    states = watch.published_states(PAGE)
    assert states["claude-sonnet-4-5-20250929"].state == "Deprecated"
    assert states["claude-sonnet-4-5-20250929"].retirement == datetime(2026, 11, 30, tzinfo=timezone.utc)
    assert states["claude-sonnet-5-5"].not_before and not states["claude-sonnet-4-5-20250929"].not_before


def test_a_model_deprecated_on_the_page_alerts_even_if_the_api_says_active():
    """Found on October 22, 2026: the Models API said “active” for Claude Sonnet 4.5."""
    catalog = {"claude-sonnet-4-5-20250929": model("claude-sonnet-4-5-20250929")}
    report = watch.examine_models(catalog, watch.published_states(PAGE), {"MODEL": "claude-sonnet-4-5-20250929"},
                                  120, NOW)
    assert any("Deprecated" in a and "2026-11-30" in a for a in report.alerts)
    assert any("the page is authoritative" in a for a in report.alerts)


def test_an_active_model_gives_its_floor_date_and_no_alias_escapes():
    catalog = {"claude-sonnet-5-5": model("claude-sonnet-5-5"),
               "claude-haiku-4-5-20251001": model("claude-haiku-4-5-20251001")}
    report = watch.examine_models(catalog, watch.published_states(PAGE),
                                  {"MODEL": "claude-sonnet-5-5", "ROUTER_MODEL": "claude-haiku-4-5"}, 120, NOW)
    assert report.alerts == []
    assert any("not before 2027-09-28" in i for i in report.infos)
    assert any(i.startswith("claude-haiku-4-5 ") for i in report.infos)  # the alias finds the dated version


def test_a_nearby_retirement_or_a_missing_model_alerts():
    near = model("claude-x-1", retirement=datetime(2026, 12, 1, tzinfo=timezone.utc))
    report = watch.examine_models({"claude-x-1": near}, {}, {"A": "claude-x-1", "B": "claude-gone-1"}, 120, NOW)
    assert any("retirement on 2026-12-01, in 40 days" in a for a in report.alerts)
    assert any("claude-gone-1" in a and "missing" in a for a in report.alerts)
    assert watch.examine_models({}, None, {}, 120, NOW).alerts == [
        "Deprecations page unreachable: only the Models API was read"]


def test_one_more_major_version_of_the_sdk_alerts():
    assert watch.examine_sdk("1.15.0", "2.1.0", "2023-06-01").alerts
    minor = watch.examine_sdk("2.0.0", "2.1.0", "2026-10-21")
    assert not minor.alerts and "same major version" in minor.infos[0]
    assert "up to date" in watch.examine_sdk("2.1.0", "2.1.0", "2026-10-21").infos[0]
    assert watch.examine_sdk("2.1.0", None, "2026-10-21").alerts


def test_the_models_written_in_the_repository_are_listed(tmp_path):
    (tmp_path / "comptoir").mkdir()
    (tmp_path / "comptoir" / "call.py").write_text('MODEL = "claude-sonnet-4-5-20250929"\n', encoding="utf-8")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_x.py").write_text('"claude-haiku-4-5"\n', encoding="utf-8")  # the tests do not count
    assert watch.models_of_the_repository(tmp_path) == {"claude-sonnet-4-5-20250929": {"comptoir/call.py"}}


# --- Erasure on request, with WhatsApp ---------------------------------------------------------

def test_erasing_a_conversation_also_erases_the_whatsapp_number(monkeypatch, tmp_path):
    """Found while writing the operations procedure: the number remained in the directory of chapter 19."""
    monkeypatch.setattr("comptoir.config.PSEUDONYM_SALT", "test-salt")
    shop, conversations, directory = Shop(), Conversations(), whatsapp.Directory()
    conversation = conversations.create("system-v5")
    directory.link(whatsapp.pseudonym("22997000000", "test-salt"), "22997000000", conversation)
    result = data.erase_number(shop, conversations, directory, "22997000000")
    assert result["conversation_found"] and result["conversation_erased"] and result["number_erased"]
    assert directory.conversation(whatsapp.pseudonym("22997000000", "test-salt")) is None
    assert data.erase_number(shop, conversations, directory, "22997000000") == {"conversation_found": False}


def test_the_daily_purge_also_forgets_old_numbers():
    assert data.purge(Shop(), Conversations(), whatsapp.Directory())["whatsapp_customers_forgotten"] == 0


# --- The estimate of a project, and the watch job ---------------------------------------------------

def test_the_estimate_starts_from_the_measured_prices_and_counts_the_free_messages():
    from ch21 import estimate_project as ep
    e = ep.estimate(1500, whatsapp=True, hosting=7.0)
    assert e.claude == pytest.approx(1500 * 0.00075) and e.claude_with_margin == pytest.approx(1500 * 0.00075 * 1.5)
    assert e.whatsapp == pytest.approx(500 * 0.0040)            # 1,000 free service messages per month
    assert e.total == pytest.approx(1.6875 + 2.0 + 7.0)
    assert ep.estimate(800, whatsapp=True).whatsapp == 0.0
    no_hosting = ep.estimate(1500)
    assert no_hosting.total is None and "[to be measured]" in ep.to_text(no_hosting, 1500)


def test_the_watch_job_is_scheduled_without_a_key():
    from pathlib import Path
    text = (Path(__file__).resolve().parents[2] / ".github/workflows/watch.yml").read_text(encoding="utf-8")
    assert "secrets." not in text and "id-token: write" in text and "cron:" in text
    assert "python -m ch21.watch" in text and "timeout-minutes:" in text
