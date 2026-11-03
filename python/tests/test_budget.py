"""The budget: reserve the maximum, settle the real cost, never exceed a ceiling."""

from datetime import datetime, timezone

import pytest

from comptoir.budget import Budget
from comptoir.costs import max_cost


@pytest.fixture(autouse=True)
def ceilings(monkeypatch):
    monkeypatch.setattr("comptoir.config.CUSTOMER_DAILY_QUOTA", 0.15)
    monkeypatch.setattr("comptoir.config.DAILY_BUDGET", 1.30)
    monkeypatch.setattr("comptoir.config.MONTHLY_BUDGET", 26.0)
    monkeypatch.setattr("comptoir.config.ALERT_THRESHOLD", 0.8)


class Clock:
    def __init__(self, instant):
        self.instant = instant

    def __call__(self):
        return self.instant


def test_the_maximum_cost_of_a_call():
    # 3,000 input tokens and at most 2,000 output tokens, at the price of Sonnet 5.5 ($2 and $10 per million).
    assert max_cost("claude-sonnet-5-5", 3000, 2000) == pytest.approx(0.026)


def test_reserve_then_settle_the_real_cost():
    budget = Budget()
    decision = budget.reserve("c1", 0.026)
    assert decision.accepted and budget.for_day() == pytest.approx(0.026)
    budget.settle(decision.reservation, 0.004)
    assert budget.for_day() == pytest.approx(0.004) and budget.for_customer("c1") == pytest.approx(0.004)


def test_one_customers_quota_does_not_block_the_others():
    budget = Budget()
    for _ in range(5):
        budget.settle(budget.reserve("chatty", 0.026).reservation, 0.026)
    decision = budget.reserve("chatty", 0.026)
    assert not decision.accepted and decision.reason == "customer_quota"
    assert budget.reserve("other", 0.026).accepted


def test_calls_in_progress_count():
    # Ten calls started together cannot exceed the ceiling between the ten of them.
    budget = Budget()
    accepted = [budget.reserve(f"customer-{i}", 0.14).accepted for i in range(10)]
    assert accepted.count(True) == 9  # 9 × $0.14 = $1.26; the tenth would go over $1.30


def test_release_a_reservation():
    budget = Budget()
    budget.release(budget.reserve("c1", 0.10).reservation)
    assert budget.for_day() == 0


def test_the_alert_before_the_ceiling():
    budget = Budget()
    assert not budget.reserve("c1", 0.10).alert
    for i in range(8):
        budget.reserve(f"c{i + 2}", 0.13)
    assert budget.on_alert()  # $1.14 committed out of $1.30: more than 80%


def test_a_new_day_starts_from_zero_but_not_the_month(monkeypatch):
    monkeypatch.setattr("comptoir.config.MONTHLY_BUDGET", 1.50)
    monkeypatch.setattr("comptoir.config.CUSTOMER_DAILY_QUOTA", 2.0)
    clock = Clock(datetime(2026, 10, 20, 23, 0, tzinfo=timezone.utc))
    budget = Budget(clock=clock)
    budget.reserve("c1", 0.10)
    budget.settle(budget.reserve("c2", 1.10).reservation, 1.10)
    clock.instant = datetime(2026, 10, 21, 0, 30, tzinfo=timezone.utc)
    assert budget.for_day() == 0 and budget.for_month() == pytest.approx(1.20)
    decision = budget.reserve("c3", 0.40)
    assert not decision.accepted and decision.reason == "monthly_budget"
