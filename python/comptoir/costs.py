"""Convert the consumption of a call (the usage field) into dollars.

Prices read on platform.claude.com on October 19, 2026, rechecked on October 22, 2026 (Appendix D),
in dollars per million tokens.
Check them before using them: they change (Appendix D, companion page).
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Rate:
    input: float           # input tokens outside the cache
    write_5m: float        # writing to the 5-minute cache
    write_1h: float        # writing to the one-hour cache
    cache_read: float      # reading from the cache
    output: float          # output tokens, thinking included


RATES = {
    "claude-fable-5-1": Rate(10.00, 12.50, 20.00, 0.25, 50.00),
    "claude-opus-5-5": Rate(4.00, 5.00, 8.00, 0.20, 20.00),
    "claude-sonnet-5-5": Rate(2.00, 2.50, 4.00, 0.10, 10.00),
    "claude-haiku-5-5": Rate(0.10, 0.125, 0.20, 0.01, 0.50),
}

# Claude Haiku 5.5 costs more when the prompt goes beyond 100,000 tokens.
LONG_PROMPT_THRESHOLD = 100_000
LONG_PROMPT_RATES = {
    "claude-haiku-5-5": Rate(0.50, 0.625, 1.00, 0.05, 2.50),
}

# Batch API (batch processing): 50% discount on input and output, and the cache
# multipliers stack with this discount, so every item is halved.
# Source: Anthropic's Pricing page, reread on October 20, 2026.
BATCH_DISCOUNT = 0.5


def _read(obj, name, default=0):
    """Reads a field, whether the usage comes from the SDK (object) or from JSON (dictionary)."""
    if obj is None:
        return default
    value = obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)
    return default if value is None else value


@dataclass(frozen=True)
class Cost:
    dollars: float
    input: int
    cache_write: int
    cache_read: int
    output: int
    thinking: int
    searches: int = 0  # web searches, billed separately (chapter 10)

    def __str__(self) -> str:
        return f"${self.dollars:.4f}"


# Web search: $10 per 1,000 searches, on top of the tokens (Pricing, October 20, 2026).
# Same price through the Batch API. Fetching pages costs only its tokens; code
# execution has 1,550 free hours per month and per organization (chapter 10).
WEB_SEARCH_PRICE = 10.0 / 1000


def max_cost(model: str, input_tokens: int, max_tokens: int, cache_write: str | None = None) -> float:
    """The highest possible cost of a call, in dollars, before running it (chapter 8).

    The input is known (count_tokens, free); the output will not exceed max_tokens,
    thinking included. cache_write ("5m" or "1h", chapter 11): if the request sets a
    cache breakpoint, the worst case is an input entirely written to the cache, which costs
    1.25 or 2 times the input price.
    """
    if model not in RATES:
        raise ValueError(f"Unknown price for the model {model!r}: add it to RATES.")
    rate = RATES[model]
    if input_tokens > LONG_PROMPT_THRESHOLD and model in LONG_PROMPT_RATES:
        rate = LONG_PROMPT_RATES[model]
    input_price = {"5m": rate.write_5m, "1h": rate.write_1h}.get(cache_write, rate.input)
    return (input_tokens * input_price + max_tokens * rate.output) / 1_000_000


def cache_duration(request) -> str | None:
    """The most expensive cache duration a request asks for: "1h", "5m", or None without a cache
    breakpoint. The breakpoints can be anywhere: at the top, on a tool, a block, a message."""
    durations = set()

    def walk(obj):
        if isinstance(obj, dict):
            control = obj.get("cache_control")
            if isinstance(control, dict):
                durations.add(control.get("ttl", "5m"))
            for value in obj.values():
                walk(value)
        elif isinstance(obj, list):
            for value in obj:
                walk(value)

    walk(request)
    return "1h" if "1h" in durations else ("5m" if durations else None)


def cost(model: str, usage, batch: bool = False) -> Cost:
    """Calculates the cost of a call from its usage field.

    batch=True for a call made through the Batch API. usage.service_tier may be
    "batch", but the discount is still requested explicitly by the caller.
    """
    if model not in RATES:
        raise ValueError(f"Unknown price for the model {model!r}: add it to RATES.")

    input_tokens = _read(usage, "input_tokens")
    output_tokens = _read(usage, "output_tokens")
    cache_read = _read(usage, "cache_read_input_tokens")
    cache_write = _read(usage, "cache_creation_input_tokens")
    write_detail = _read(usage, "cache_creation", None)
    write_1h = _read(write_detail, "ephemeral_1h_input_tokens")
    write_5m = cache_write - write_1h  # without detail, everything is counted as 5 minutes
    thinking = _read(_read(usage, "output_tokens_details", None), "thinking_tokens")
    searches = _read(_read(usage, "server_tool_use", None), "web_search_requests")

    # The prompt length counts all input tokens, cache included.
    prompt_length = input_tokens + cache_read + cache_write
    rate = RATES[model]
    if prompt_length > LONG_PROMPT_THRESHOLD and model in LONG_PROMPT_RATES:
        rate = LONG_PROMPT_RATES[model]

    dollars = (
        input_tokens * rate.input
        + write_5m * rate.write_5m
        + write_1h * rate.write_1h
        + cache_read * rate.cache_read
        + output_tokens * rate.output  # output_tokens already includes thinking
    ) / 1_000_000
    if batch:
        dollars *= BATCH_DISCOUNT  # after choosing the rate: the threshold applies to the raw tokens
    dollars += searches * WEB_SEARCH_PRICE  # no batch discount

    return Cost(dollars, input_tokens, cache_write, cache_read, output_tokens, thinking, searches)
