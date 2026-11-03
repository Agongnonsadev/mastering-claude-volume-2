"""The dashboard reads the log: costs per day, failure modes, latencies, conversations to pick up."""

import json

from comptoir.dashboard import by_day, failure_modes, latencies, load, percentile, to_html, to_pick_up

LOG = [
    {"date": "2026-10-20T08:00:00+00:00", "request": "r1", "cost_dollars": 0.004, "input_tokens": 1000,
     "output_tokens": 100, "stop_reason": "end_turn", "duration_ms": 900, "customer": "c1"},
    {"date": "2026-10-20T08:05:00+00:00", "request": "r2", "cost_dollars": 0.006, "input_tokens": 1500,
     "output_tokens": 150, "stop_reason": "end_turn", "duration_ms": 1500, "customer": "c1"},
    {"date": "2026-10-20T09:00:00+00:00", "request": None, "cost_dollars": None, "interrupted": True,
     "error": "overloaded", "origin": "service", "duration_ms": 30000, "customer": "c2"},
    {"date": "2026-10-20T10:00:00+00:00", "request": "r4", "cost_dollars": 0.001, "stop_reason": "refusal",
     "error": "refusal", "origin": "model", "customer": "c3"},
    {"date": "2026-10-21T07:00:00+00:00", "event": "over_budget", "reason": "customer_quota", "customer": "c4"},
]


def test_the_costs_per_day():
    days = by_day(LOG)
    assert days["2026-10-20"]["calls"] == 4 and round(days["2026-10-20"]["dollars"], 6) == 0.011
    assert days["2026-10-20"]["failures"] == 2 and days["2026-10-21"]["failures"] == 1


def test_the_failure_modes_by_origin():
    assert failure_modes(LOG) == {("service", "overloaded"): 1, ("model", "refusal"): 1, ("account", "over_budget"): 1}


def test_the_latencies_ignore_the_failures():
    assert latencies(LOG) == (900, 1500)  # the overloaded call (30 s) is not counted
    assert percentile([], 50) is None


def test_the_conversations_to_pick_up():
    # An overload is retried; a refusal or a used-up budget leave the customer without an answer.
    assert [r["conversation"] for r in to_pick_up(LOG)] == ["c3", "c4"]


def test_the_html_page_escapes_the_content_of_the_log(tmp_path):
    path = tmp_path / "calls.jsonl"
    trap = {"date": "2026-10-20T11:00:00+00:00", "event": "over_budget", "customer": "<script>x</script>"}
    path.write_text("\n".join(json.dumps(l) for l in LOG + [trap]) + "\n", encoding="utf-8")
    page = to_html(load(str(path)))
    assert "<script>x</script>" not in page and "&lt;script&gt;" in page
