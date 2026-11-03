"""Chapter 18: the attacks that cost nothing, and the audit's checks, run on the code.

Run, from the python/ folder (FREE: a fake client, no call to the API):
    python -m ch18.code_audit --label before
    python -m ch18.code_audit --label after

Five attacks, on the web Comptoir (chapter 6), on its tools and on the repository:
  6. a new conversation at each message, to escape the quota per customer;
  7. a burst of messages, then a giant request body;
  8. HTML in Claude's answer, to run a script on the customer's side;
  9. another customer's conversation: a guessed ID, tools turned away from their use;
 10. the API key: repository, Git history, logs, results.
And two checks, reading the code against its promises:
  C1. are the personal data deleted on the promised date?
  C2. does the customer know they are talking to an AI?

The same script serves before and after the fixes: it attacks through the public doors
(the web API, the tools, the files), without assuming anything about the code that guards them.
Result: a table, and ch18/results/audit-<label>.json.
"""

import argparse
import json
import re
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from anthropic.types import TextBlock, Usage

FOLDER = Path(__file__).parent
ROOT = FOLDER.parent                         # tome-2-en/code/python
REPOSITORY = ROOT.parents[2]                 # the root of the Git repository
RESULTS = FOLDER / "results"

ATTACKER = ("196.168.10.20", 40000)          # a fixed address for the attacker
CUSTOMER = ("196.168.77.5", 40001)           # and another one for a real customer
TRAPPED_HTML = "<img src=x onerror=\"alert('Comptoir')\">"
KEY = re.compile(r"sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,}")


# --- A fake client: it always answers, without billing anything -------------------------------------

class _Stream:
    def __init__(self, text: str):
        self.text, self.request_id = text, "req_audit"
        self.message = SimpleNamespace(content=[TextBlock(type="text", text=text)], stop_reason="end_turn",
                                       usage=Usage(input_tokens=1000, output_tokens=50))

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    @property
    def text_stream(self):
        async def chunks():
            yield self.text
        return chunks()

    async def get_final_message(self):
        return self.message


class FakeClient:
    """The SDK's client, as the Comptoir sees it: each message gets the same answer, 1,000 input tokens and 50 output."""

    def __init__(self, text: str = "Hello! What can I do for you?"):
        self.messages, self.text, self.calls = self, text, 0

    def stream(self, **request):
        self.calls += 1
        return _Stream(self.text)

    async def count_tokens(self, **request):
        return SimpleNamespace(input_tokens=1000)


def _application(text: str | None = None):
    from comptoir.budget import Budget
    from comptoir.conversations import Conversations
    from comptoir.web import create_app

    client, budget = FakeClient(text) if text else FakeClient(), Budget(":memory:")
    return create_app(client, Conversations(), budget), client, budget


def _events(body: str) -> list[tuple[str, dict]]:
    output = []
    for block in body.split("\n\n"):
        name = next((l[7:] for l in block.splitlines() if l.startswith("event: ")), None)
        data = "".join(l[6:] for l in block.splitlines() if l.startswith("data: "))
        if name:
            output.append((name, json.loads(data)))
    return output


def _send(http, text: str, conversation: str | None = None) -> tuple[int, str, str | None]:
    """(HTTP status, outcome, conversation); outcome: end, error, refusal or the status itself."""
    r = http.post("/api/messages", json={"conversation": conversation, "message_id": uuid.uuid4().hex,
                                         "text": text, "since": 0})
    if r.status_code != 200:
        return r.status_code, str(r.status_code), conversation
    events = _events(r.text)
    conv = next((d["conversation"] for n, d in events if n == "conversation"), None)
    outcome = next((n for n, _ in events if n in ("end", "error", "refusal")), "none")
    return 200, outcome, conv


# --- The attacks ------------------------------------------------------------------------------

def attack_6_new_conversations(max_trials: int = 1000) -> dict:
    """A new conversation at each message: the quota per customer never sees the same customer twice."""
    from fastapi.testclient import TestClient

    app, client, budget = _application()
    accepted, first_refusal = 0, None
    with TestClient(app, client=ATTACKER) as http:
        for _ in range(max_trials):
            status, outcome, _ = _send(http, "Hello, do you have bissap juice?")
            if outcome == "end":
                accepted += 1
            else:
                first_refusal = outcome
                break
    with TestClient(app, client=CUSTOMER) as http:
        _, customer_outcome, _ = _send(http, "Hello, I'd like to order 6 pineapple juices.")
    return {
        "messages_accepted": accepted,
        "stop": first_refusal,
        "spending_of_the_day_dollars": round(budget.for_day(), 4),
        "calls_to_claude": client.calls,
        "a_real_customer_afterwards": customer_outcome,
        "verdict": "flaw" if customer_outcome != "end" else "held",
    }


def attack_7_burst_and_giant_body() -> dict:
    """60 messages in a minute in the same conversation, then a text that is too long, then a 3 MB body."""
    from fastapi.testclient import TestClient

    app, _, _ = _application()
    with TestClient(app, client=ATTACKER) as http:
        accepted, conversation, start = 0, None, time.monotonic()
        for _ in range(60):
            status, outcome, conversation = _send(http, "Another question about bissap.", conversation)
            accepted += outcome == "end"
        duration = time.monotonic() - start
        long_status, _, _ = _send(http, "a" * 10_000)
        body = json.dumps({"conversation": None, "message_id": uuid.uuid4().hex, "text": "b" * 3_000_000})
        start = time.monotonic()
        r = http.post("/api/messages", content=body, headers={"content-type": "application/json"})
        body_duration = time.monotonic() - start
    return {
        "burst_accepted": f"{accepted} out of 60 in {duration:.1f} s",
        "text_of_10000_characters": long_status,
        "body_of_3_mb": r.status_code,
        "body_of_3_mb_handled_in_s": round(body_duration, 3),
        "verdict": "flaw" if accepted == 60 or r.status_code != 413 else "held",
    }


def attack_8_html_in_the_answer() -> dict:
    """Claude answers with trapped HTML: does the stream carry it as is, does the page run it?"""
    from fastapi.testclient import TestClient

    app, _, _ = _application(TRAPPED_HTML)
    with TestClient(app, client=CUSTOMER) as http:
        r = http.post("/api/messages", json={"conversation": None, "message_id": uuid.uuid4().hex,
                                             "text": "Write the juice's name in HTML for my website", "since": 0})
        page = http.get("/").text
    texts = [d.get("text", "") for n, d in _events(r.text) if n == "text"]
    script = page.split("<script>", 1)[1].split("</script>", 1)[0] if "<script>" in page else ""
    code = "\n".join(l.split("//", 1)[0] for l in script.splitlines())  # without the comments
    dangerous = sorted({m for m in re.findall(r"innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(", code)})
    return {
        "html_received_as_text": TRAPPED_HTML in "".join(texts),
        "dangerous_insertions_in_the_page": dangerous,
        "verdict": "held" if not dangerous else "flaw",
    }


def attack_9_another_customer_s_conversation() -> dict:
    """Guess a conversation's ID; turn a tool toward another customer's order."""
    from fastapi.testclient import TestClient

    from comptoir.shop import Shop
    from comptoir.tools import Execution, Tools

    app, _, _ = _application()
    guesses = ("0" * 32, "1", "rachidatou-conversation")
    with TestClient(app, client=ATTACKER) as http:
        guessed = [_send(http, "Remind me of my address.", c)[2] for c in guesses]
    # The conversation the tool sees is the one the code gave it, whatever the arguments.
    shop = Shop(":memory:")
    victim, attacker = uuid.uuid4().hex, uuid.uuid4().hex
    shop.prepare(victim, [{"product": "Bissap juice", "quantity": 6}], "Rachidatou", "Zogbo")
    call = SimpleNamespace(id="toolu_audit", name="order_prepare",
                           input={"lines": [{"product": "Bissap juice", "quantity": 1}], "customer_name": "X",
                                  "neighborhood": "Zogbo", "conversation": victim})
    Tools(shop, attacker).execute(call, Execution())
    victim_statuses = [status for _, status, _, _ in shop.summaries(victim)]
    return {
        "guessed_ids_accepted": sum(1 for c in guessed if c in guesses),
        "victim_s_summary": victim_statuses,
        "tools_available": "stock_check, order_prepare, pass_to_awa (none reads another conversation)",
        "verdict": "held" if victim_statuses == ["pending"] and not any(c in guesses for c in guessed) else "flaw",
    }


def attack_10_the_key() -> dict:
    """Look for an API key: tracked files, the whole Git history, logs and results on the disk."""
    def git(*args) -> str:
        return subprocess.run(["git", "-C", str(REPOSITORY), *args], capture_output=True, text=True,
                              encoding="utf-8", errors="replace").stdout

    tracked = [l for l in git("grep", "-I", "-n", "-E", KEY.pattern).splitlines() if l]
    history = KEY.findall(git("log", "-p", "--all", "--no-color"))
    on_disk = []
    for folder in ("log", "reports", "customer_data", "ch17/results", "ch18/results"):
        for f in (ROOT / folder).rglob("*"):
            if f.is_file() and f.suffix in (".jsonl", ".json", ".txt", ".csv", ".md", ".html"):
                if KEY.search(f.read_text(encoding="utf-8", errors="ignore")):
                    on_disk.append(str(f.relative_to(ROOT)))
    ignored = git("check-ignore", "-v", str(ROOT / ".env"), str(ROOT / "ch16" / "deployment" / ".env")).strip()
    return {
        "keys_in_the_tracked_files": len(tracked),
        "keys_in_the_git_history": len(history),
        "local_files_with_a_key": on_disk,
        "env_ignored_by_git": bool(ignored),
        "verdict": "held" if not (tracked or history or on_disk) and ignored else "flaw",
    }


# --- The checks -----------------------------------------------------------------------------

def check_1_retention() -> dict:
    """The conversations are promised deleted after 30 days (chapter 6): who deletes them?"""
    calls = []
    for f in list((ROOT / "comptoir").glob("*.py")) + list(ROOT.glob("ch*/*.py")):
        if f.name == "code_audit.py":
            continue
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"\.purge\(", line) and "def purge" not in line:
                calls.append(f"{f.relative_to(ROOT)}:{n}")
    from comptoir.shop import Shop

    tables_without_purge = [t for t in ("summaries", "requests") if not hasattr(Shop, "purge")]
    return {
        "calls_to_purge_in_the_application": calls,
        "shop_tables_never_purged": tables_without_purge,
        "verdict": "held" if calls and not tables_without_purge else "flaw",
    }


def check_2_ai_disclosure() -> dict:
    """Anthropic's usage policy: an assistant that talks to customers must say it is an AI."""
    page = (ROOT / "comptoir" / "pages" / "comptoir.html").read_text(encoding="utf-8")
    visible = re.sub(r"<script>.*?</script>|<style>.*?</style>|<[^>]+>", " ", page, flags=re.S)
    disclosure = bool(re.search(r"artificial\s+intelligence|\bAI\b", visible))
    return {"disclosure_in_the_page": disclosure, "verdict": "held" if disclosure else "flaw"}


ATTACKS = {
    "6. A new conversation at each message": attack_6_new_conversations,
    "7. Burst and giant body": attack_7_burst_and_giant_body,
    "8. HTML in the answer": attack_8_html_in_the_answer,
    "9. Another customer's conversation": attack_9_another_customer_s_conversation,
    "10. The API key": attack_10_the_key,
    "C1. Data kept beyond 30 days": check_1_retention,
    "C2. Does the customer know they are talking to an AI?": check_2_ai_disclosure,
}


def audit() -> dict:
    from comptoir import config

    with tempfile.TemporaryDirectory() as folder:
        # Nothing is written to the Comptoir's log: the audit has its own, thrown away at the end.
        config.LOG = str(Path(folder) / "audit-log.jsonl")
        results = {}
        for name, attack in ATTACKS.items():
            start = time.perf_counter()
            results[name] = attack()
            results[name]["duration_s"] = round(time.perf_counter() - start, 2)
    return results


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--label", default=datetime.now().strftime("%Y%m%d-%H%M%S"))
    args = parser.parse_args()
    results = audit()
    for name, r in results.items():
        print(f"{r['verdict'].upper():6} {name}")
        for key, value in r.items():
            if key not in ("verdict",):
                print(f"         {key}: {value}")
    RESULTS.mkdir(parents=True, exist_ok=True)
    output = RESULTS / f"audit-{args.label}.json"
    output.write_text(json.dumps({"date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                  "results": results}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {output.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
