"""The Comptoir's limits on the web (chapter 18): who sends, how much, and what size.

The budget of chapter 8 counts per conversation: a script that opens a new conversation at each
message never sees it come back. It empties the day's budget, and real customers receive “The
Comptoir can't answer right now”. The audit of chapter 18 did it: 512 messages, from a single
address, before the refusal. Hence three limits per network address, in front of the budget:
- messages per minute: a burst stops;
- new conversations per hour: getting around the customer quota stops;
- a quota in dollars per day (comptoir/budget.py, group): an address never takes the whole day.

An address is not a person: behind that of a mobile operator, there are often many
subscribers. The limits are generous, made for a script; the solid identity will come from the phone
number, with WhatsApp (chapter 19).

The counters live in memory: a restart resets them to zero, which is acceptable to stop
a burst. The quota in dollars, for its part, is in the budget's database.
"""

import threading
import time
from collections import defaultdict, deque


class RateLimiter:
    """A sliding window per key: at most `maximum` events during `window_s` seconds."""

    def __init__(self, maximum: int, window_s: float, clock=time.monotonic):
        self.maximum, self.window_s, self._clock = maximum, window_s, clock
        self._events: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def accept(self, key: str) -> float | None:
        """None if the event is accepted (and counted); otherwise, the number of seconds to wait."""
        now = self._clock()
        with self._lock:
            queue = self._events[key]
            while queue and queue[0] <= now - self.window_s:
                queue.popleft()
            if len(queue) >= self.maximum:
                return round(queue[0] + self.window_s - now, 1)
            queue.append(now)
            return None


def client_address(host: str | None, forwarded_for: str | None, trusted_proxies: list[str]) -> str:
    """The customer's address. Behind a trusted proxy (Caddy), it is the last address this proxy
    added to X-Forwarded-For; without a trusted proxy, the header is ignored: anyone can write it."""
    if host in trusted_proxies and forwarded_for:
        return forwarded_for.split(",")[-1].strip()
    return host or "unknown"
