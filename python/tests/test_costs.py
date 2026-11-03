"""Tests of the cost calculator, without any call to the API."""

import pytest
from anthropic.types import CacheCreation, Usage

from comptoir.costs import cost


def test_book_example_sonnet():
    # Chapter 1: 2,000 input tokens and 300 output tokens on Sonnet 5.5 = $0.007.
    usage = Usage(input_tokens=2000, output_tokens=300)
    assert cost("claude-sonnet-5-5", usage).dollars == pytest.approx(0.007)


def test_display_in_dollars():
    price = cost("claude-sonnet-5-5", Usage(input_tokens=2000, output_tokens=300))
    assert str(price) == "$0.0070"


def test_accepts_a_dictionary_from_json():
    usage = {"input_tokens": 2000, "output_tokens": 300, "cache_read_input_tokens": None}
    assert cost("claude-sonnet-5-5", usage).dollars == pytest.approx(0.007)


def test_cache_read_and_writes():
    usage = Usage(
        input_tokens=50,
        output_tokens=100,
        cache_read_input_tokens=10_000,
        cache_creation_input_tokens=3_000,
        cache_creation=CacheCreation(ephemeral_5m_input_tokens=2_000, ephemeral_1h_input_tokens=1_000),
    )
    expected = (50 * 2 + 100 * 10 + 10_000 * 0.10 + 2_000 * 2.50 + 1_000 * 4.00) / 1_000_000
    assert cost("claude-sonnet-5-5", usage).dollars == pytest.approx(expected)


def test_write_without_detail_counted_as_five_minutes():
    usage = Usage(input_tokens=0, output_tokens=0, cache_creation_input_tokens=1_000_000)
    assert cost("claude-opus-5-5", usage).dollars == pytest.approx(5.0)


def test_haiku_changes_rate_beyond_100_000_tokens():
    short = Usage(input_tokens=100_000, output_tokens=1_000)
    long = Usage(input_tokens=100_001, output_tokens=1_000)
    assert cost("claude-haiku-5-5", short).dollars == pytest.approx((100_000 * 0.10 + 1_000 * 0.50) / 1e6)
    assert cost("claude-haiku-5-5", long).dollars == pytest.approx((100_001 * 0.50 + 1_000 * 2.50) / 1e6)


def test_the_cache_counts_in_the_length_of_haikus_prompt():
    # 1,000 tokens outside the cache + 150,000 read from the cache: the prompt goes beyond 100,000 tokens.
    usage = Usage(input_tokens=1_000, output_tokens=0, cache_read_input_tokens=150_000)
    assert cost("claude-haiku-5-5", usage).dollars == pytest.approx((1_000 * 0.50 + 150_000 * 0.05) / 1e6)


def test_unknown_model():
    with pytest.raises(ValueError):
        cost("claude-imaginary-model", Usage(input_tokens=1, output_tokens=1))


# Chapter 4: the Batch API discount, added with Claude Code then reviewed.

def test_batch_halves_the_book_example():
    usage = Usage(input_tokens=2000, output_tokens=300)
    assert cost("claude-sonnet-5-5", usage, batch=True).dollars == pytest.approx(0.0035)


def test_batch_stacks_with_the_cache():
    usage = Usage(
        input_tokens=50,
        output_tokens=100,
        cache_read_input_tokens=10_000,
        cache_creation_input_tokens=3_000,
        cache_creation=CacheCreation(ephemeral_5m_input_tokens=2_000, ephemeral_1h_input_tokens=1_000),
    )
    expected = (50 * 2 + 100 * 10 + 10_000 * 0.10 + 2_000 * 2.50 + 1_000 * 4.00) / 1_000_000
    assert cost("claude-sonnet-5-5", usage, batch=True).dollars == pytest.approx(expected * 0.5)


def test_batch_and_haikus_long_prompt():
    # The 100,000-token threshold is calculated on the raw tokens, before the discount.
    long = Usage(input_tokens=100_001, output_tokens=1_000)
    expected = (100_001 * 0.50 + 1_000 * 2.50) / 1e6 * 0.5
    assert cost("claude-haiku-5-5", long, batch=True).dollars == pytest.approx(expected)


def test_batch_false_by_default():
    usage = Usage(input_tokens=2000, output_tokens=300)
    assert cost("claude-sonnet-5-5", usage) == cost("claude-sonnet-5-5", usage, batch=False)


def test_batch_keeps_the_token_counts():
    usage = Usage(input_tokens=2000, output_tokens=300, cache_read_input_tokens=500)
    normal = cost("claude-sonnet-5-5", usage)
    batch = cost("claude-sonnet-5-5", usage, batch=True)
    assert (batch.input, batch.cache_read, batch.output) == (normal.input, normal.cache_read, normal.output)
