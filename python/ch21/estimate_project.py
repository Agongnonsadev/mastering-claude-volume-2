"""Chapter 21: estimate what an assistant like the Comptoir will cost a client, each month.

From the python/ folder (free, no call):
    python -m ch21.estimate_project --messages 1500 --whatsapp --hosting 7
    python -m ch21.estimate_project --messages 1500 --message-cost 0.0009

An estimate, not a measurement: it starts from the unit prices measured in this book, for an application that
resembles the Comptoir (Claude Haiku 5.5, tools, cache, complaints drafted by Claude Sonnet 5.5). For
another application, first measure its cost per message (chapter 19), then pass it as --message-cost.
The hosting was not measured in this book: it is up to you to give it.
"""

import argparse
import sys
from dataclasses import dataclass

# Chapter 19: eight typical conversations, three trials, on October 22, 2026 ($0.00075 per message).
COST_PER_MESSAGE = 0.00075
# Chapter 19: rate of a WhatsApp service message, “Rest of Africa” region, read on October 22, 2026,
# and the 1,000 free service messages per month and per number.
WHATSAPP_RATE, WHATSAPP_FREE = 0.0040, 1000
MARGIN = 0.5  # chapter 1: half again, for what the measurement did not see (peaks, long conversations)


@dataclass
class Estimate:
    claude: float
    claude_with_margin: float
    whatsapp: float
    hosting: float | None

    @property
    def total(self) -> float | None:
        return None if self.hosting is None else self.claude_with_margin + self.whatsapp + self.hosting


def estimate(messages: int, message_cost: float = COST_PER_MESSAGE, whatsapp: bool = False,
             whatsapp_rate: float = WHATSAPP_RATE, hosting: float | None = None) -> Estimate:
    claude = messages * message_cost
    channel = max(0, messages - WHATSAPP_FREE) * whatsapp_rate if whatsapp else 0.0
    return Estimate(claude, claude * (1 + MARGIN), channel, hosting)


def to_text(e: Estimate, messages: int) -> str:
    def line(name, dollars):
        if dollars is None:
            return f"{name:<38} [to be measured]"
        return f"{name:<38}{'$' + format(dollars, '.2f'):>7}"
    lines = [f"For {messages:,} messages a month:",
             line("Claude (measured unit price)", e.claude),
             line(f"Claude, with a {MARGIN:.0%} margin", e.claude_with_margin),
             line("WhatsApp (service messages)", e.whatsapp),
             line("Hosting", e.hosting),
             line("Total per month", e.total)]
    if e.total is not None and messages:
        lines.append(f"{'Per message':<38}{'$' + format(e.total / messages, '.4f'):>7}")
    return "\n".join(lines)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--messages", type=int, required=True, help="customer messages per month")
    parser.add_argument("--message-cost", type=float, default=COST_PER_MESSAGE, help="in dollars, measured for your application")
    parser.add_argument("--whatsapp", action="store_true", help="the customers write on WhatsApp")
    parser.add_argument("--whatsapp-rate", type=float, default=WHATSAPP_RATE, help="in dollars, for your country")
    parser.add_argument("--hosting", type=float, help="in dollars per month")
    args = parser.parse_args()
    print(to_text(estimate(args.messages, args.message_cost, args.whatsapp, args.whatsapp_rate, args.hosting),
                  args.messages))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
