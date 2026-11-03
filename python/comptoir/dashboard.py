"""Read the log: costs, failure modes, latencies, conversations to pick up (chapter 8).

The log is the trace of each call. Read properly, it answers Yao's questions:
how much did the day cost, what fails and where does it come from, who is still waiting for
an answer from Awa.

Chapter 19: the online Comptoir leaves a “message” event per message (comptoir/service.py),
with the cost of all its steps and its duration. The dashboard draws from it the cost per conversation, the latency
as the customer sees it, the error rate, the security events of chapter 18 and alerts.
"""

import html
import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from comptoir import config

# What leaves a customer without an answer: Awa must pick up the conversation by hand.
NO_ANSWER = {"refusal", "over_budget", "counting_impossible", "invalid_key", "billing", "permission",
             "not_found", "invalid_request", "spend_limit", "tier_ceiling", "context_full"}


def load(path: str | None = None) -> list[dict]:
    file = Path(path or config.LOG)
    if not file.exists():
        return []
    return [json.loads(l) for l in file.read_text(encoding="utf-8").splitlines() if l.strip()]


# The events that are not call failures: they have their own section (chapters 18 and 19).
INFORMATIONAL = {"message", "step", "purge", "guard", "limit", "suspicious_attempt", "whatsapp_send",
                 "whatsapp_invalid_signature", "monitoring"}


def is_a_failure(line: dict) -> bool:
    """A call or a message in error, a refused send, or an event that is not information.
    A step in error belongs to a message: it is counted with it, not twice."""
    event = line.get("event")
    if event is None or event in ("message", "whatsapp_send"):
        return bool(line.get("error"))
    return event not in INFORMATIONAL


def by_day(lines: list[dict]) -> dict[str, dict]:
    days: dict[str, dict] = defaultdict(lambda: {"calls": 0, "dollars": 0.0, "input": 0, "output": 0, "failures": 0})
    for line in lines:
        day = days[line["date"][:10]]
        if "event" in line:
            day["failures"] += is_a_failure(line)
            continue
        day["calls"] += 1
        day["dollars"] += line.get("cost_dollars") or 0.0
        day["input"] += (line.get("input_tokens") or 0) + (line.get("cache_read_tokens") or 0)
        day["output"] += line.get("output_tokens") or 0
        day["failures"] += 1 if line.get("error") else 0
    return dict(sorted(days.items()))


def failure_modes(lines: list[dict]) -> Counter:
    """(origin, code) -> number. The origin says who must act: the network, the service, our code…"""
    count = Counter()
    for line in lines:
        if is_a_failure(line):
            count[(line.get("origin") or "account", line.get("error") or line.get("event"))] += 1
    return count


def percentile(values: list[float], rank: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round(rank / 100 * (len(ordered) - 1)))]


def latencies(lines: list[dict]) -> tuple[float | None, float | None]:
    """Median and 95th percentile of the duration of successful calls, in milliseconds."""
    durations = [l["duration_ms"] for l in lines if "duration_ms" in l and not l.get("error") and "event" not in l]
    return percentile(durations, 50), percentile(durations, 95)


def to_pick_up(lines: list[dict]) -> list[dict]:
    """The conversations left without an answer, which Awa must pick up herself."""
    return [
        {"date": l["date"], "conversation": l.get("customer") or l.get("conversation"),
         "reason": l.get("error") or l.get("event")}
        for l in lines
        if (l.get("error") or l.get("event")) in NO_ANSWER
    ]


# --- The online Comptoir (chapter 19) -------------------------------------------------------------

def messages(lines: list[dict]) -> list[dict]:
    return [l for l in lines if l.get("event") == "message"]


def by_conversation(lines: list[dict]) -> dict[str, dict]:
    """conversation -> channel, number of messages, total cost. All steps included, from the trace, and
    the monitoring of chapter 18 when it is turned on (chapter 20)."""
    conversations: dict[str, dict] = defaultdict(lambda: {"channel": "", "messages": 0, "dollars": 0.0})
    for l in messages(lines):
        c = conversations[l.get("conversation", "?")]
        c["channel"], c["messages"] = l.get("channel", ""), c["messages"] + 1
        c["dollars"] += l.get("cost_dollars") or 0.0
    for l in lines:
        if l.get("event") == "monitoring" and l.get("conversation") in conversations:
            conversations[l["conversation"]]["dollars"] += l.get("cost_dollars") or 0.0
    return dict(conversations)


def cost_per_conversation(lines: list[dict]) -> dict:
    totals = [c["dollars"] for c in by_conversation(lines).values()]
    if not totals:
        return {"conversations": 0, "average": None, "median": None}
    return {"conversations": len(totals), "average": sum(totals) / len(totals), "median": percentile(totals, 50)}


def message_latencies(lines: list[dict]) -> tuple[float | None, float | None]:
    """Median and 90th percentile of the duration of a message, all steps included: what the customer waits."""
    durations = [l["duration_ms"] for l in messages(lines) if "duration_ms" in l and not l.get("error")]
    return percentile(durations, 50), percentile(durations, 90)


def error_rate(lines: list[dict]) -> float | None:
    everything = messages(lines)
    return sum(1 for l in everything if l.get("error")) / len(everything) if everything else None


def events(lines: list[dict]) -> Counter:
    """The security and operations events, by name (chapters 18 and 19)."""
    return Counter(l["event"] for l in lines
                   if l.get("event") in {"guard", "limit", "suspicious_attempt", "over_budget", "purge",
                                         "whatsapp_invalid_signature"}
                   or (l.get("event") == "whatsapp_send" and l.get("error")))


def repeat_offenders(lines: list[dict], threshold: int = 3) -> list[tuple[str, int]]:
    """The conversations flagged at least `threshold` times by the monitoring: to be looked at closely."""
    count = Counter(l.get("conversation") for l in lines if l.get("event") == "suspicious_attempt")
    return [(c, n) for c, n in count.most_common() if n >= threshold]


def alerts(lines: list[dict], now: datetime | None = None) -> list[str]:
    """What must make Awa or Yao react, over the last 24 hours."""
    instant = now or datetime.now(timezone.utc)
    recent = [l for l in lines if l.get("date", "") >= (instant - timedelta(hours=24)).isoformat(timespec="seconds")]
    out = []
    spent = sum(l.get("cost_dollars") or 0.0 for l in recent if l.get("event") in ("message", "monitoring"))
    if spent >= config.ALERT_THRESHOLD * config.DAILY_BUDGET:
        out.append(f"Spending over the last 24 hours: ${spent:.2f}, for a daily ceiling of ${config.DAILY_BUDGET:.2f}.")
    rate = error_rate(recent)
    if rate is not None and len(messages(recent)) >= 10 and rate > 0.05:
        out.append(f"{rate:.0%} of the messages of the last 24 hours failed.")
    if any(l.get("event") == "over_budget" for l in recent):
        out.append("Customers received “The Comptoir can't answer right now” for lack of budget.")
    for conversation, n in repeat_offenders(recent):
        out.append(f"The conversation {conversation[:8]}… was flagged {n} times by the monitoring.")
    if any(l.get("event") == "whatsapp_not_configured" for l in recent):
        out.append("WhatsApp is not configured (the fingerprint salt is missing): the messages are waiting at Meta.")
    if any(l.get("event") in ("whatsapp_send", "whatsapp_processing") and l.get("error") for l in recent):
        out.append("WhatsApp messages were left without an answer: send refused or processing impossible.")
    return out


def to_html(lines: list[dict]) -> str:
    """A standalone page, with no library and no network call, to open in a browser."""
    days = by_day(lines)
    dearest = max((d["dollars"] for d in days.values()), default=0) or 1
    rows = "".join(
        f"<tr><td>{day}</td><td>{d['calls']}</td><td>${d['dollars']:.4f}</td><td>{d['failures']}</td>"
        f"<td><div class='bar' style='width:{100 * d['dollars'] / dearest:.0f}%'></div></td></tr>"
        for day, d in days.items()
    )
    failures = "".join(f"<tr><td>{html.escape(o)}</td><td>{html.escape(c)}</td><td>{n}</td></tr>"
                       for (o, c), n in failure_modes(lines).most_common())
    pick_up = "".join(f"<tr><td>{html.escape(r['date'])}</td><td>{html.escape(str(r['conversation']))}</td>"
                      f"<td>{html.escape(r['reason'])}</td></tr>" for r in to_pick_up(lines))
    median, p95 = latencies(lines)
    conv = cost_per_conversation(lines)
    med_msg, p90_msg = message_latencies(lines)
    rate = error_rate(lines)
    message_duration = (f"median {med_msg:.0f} ms, 90th percentile {p90_msg:.0f} ms" if med_msg is not None
                        else "no successful message")
    online = (f"<p>{conv['conversations']} conversation{'s' if conv['conversations'] > 1 else ''}; average cost ${conv['average']:.4f}, median "
              f"${conv['median']:.4f}; a message: {message_duration}; "
              f"errors: {rate:.1%}.</p>" if conv["conversations"] else "<p>No online message so far.</p>")
    # The calls of the routed Comptoir have no duration in the log (it is on the steps): nothing to display.
    call_latency = (f"median {median:.0f} ms, 95th percentile {p95:.0f} ms" if median is not None
                    else "no call duration in the log")
    alarms = "".join(f"<li>{html.escape(a)}</li>" for a in alerts(lines)) or "<li>None.</li>"
    security = "".join(f"<tr><td>{html.escape(name)}</td><td>{n}</td></tr>" for name, n in events(lines).most_common())
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>The Comptoir: dashboard</title>
<style>body{{font-family:system-ui,sans-serif;max-width:56rem;margin:0 auto;padding:1rem;color:#2b2118;background:#fdf8f3}}
table{{border-collapse:collapse;width:100%;margin-bottom:1.5rem}}td,th{{border-bottom:1px solid #ead9c8;padding:.35rem;text-align:left}}
.bar{{background:#d9772b;height:.8rem;border-radius:.2rem}}</style></head><body>
<h1>The Comptoir: dashboard</h1>
<h2>Alerts (24 hours)</h2><ul>{alarms}</ul>
<h2>Online</h2>{online}
<h2>Security and operations</h2><table><tr><th>Event</th><th>Count</th></tr>{security}</table>
<p>Latency of successful calls: {call_latency}.</p>
<h2>By day</h2><table><tr><th>Day</th><th>Calls</th><th>Cost</th><th>Failures</th><th></th></tr>{rows}</table>
<h2>Failure modes</h2><table><tr><th>Origin</th><th>Code</th><th>Count</th></tr>{failures}</table>
<h2>Conversations for Awa to pick up</h2><table><tr><th>Date</th><th>Conversation</th><th>Reason</th></tr>{pick_up}</table>
</body></html>"""
