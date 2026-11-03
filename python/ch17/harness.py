"""The evaluation harness of chapter 17: one case, one variant, one trial, in a fresh environment.

Each trial starts from zero: an in-memory shop with the stock of chapter 9, a stopped clock
(a Tuesday at 10 a.m., Cotonou time), an empty budget, a new conversation. Nothing
passes from one trial to the next: a trial that succeeds thanks to the previous one measures nothing.

The API client is wrapped by a recorder: each call leaves in it the model, the stop,
the tokens, the duration, the cost, what Claude wrote or requested, and the tool results
it received. It is the transcript of the trial, to reread when a case fails.

The messages of this set are test cases, not customers' messages: they can
appear in the results, which the Comptoir's log, for its part, never does.
"""

import random
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime

from comptoir.budget import Budget
from comptoir.costs import cost
from comptoir.errors import ComptoirError
from comptoir.routing import RoutedComptoir
from comptoir.shop import COTONOU, Shop

TRIAL_TIME = datetime(2026, 10, 20, 10, 0, tzinfo=COTONOU)  # a Tuesday, before noon
SUMMARY_START = "\n\nYour order summary"


@dataclass(frozen=True)
class Variant:
    """What changes from one version of the Comptoir to another. The defaults are the version shipped in chapter 17;
    since chapter 18, the shipped version has prompt v5 (suite.VARIANTS["shipped"])."""

    name: str
    comptoir_model: str | None = None    # None: the shipped version's, config.COMPTOIR_MODEL
    prompt_version: str = "v3"
    documents_version: str = "v1"
    comptoir_effort: str | None = None   # chapter 19: None, the shipped version's effort


def _block_summary(block) -> dict:
    if block.type == "text":
        return {"type": "text", "text": block.text}
    if block.type == "tool_use":
        return {"type": "tool_use", "name": block.name, "input": block.input}
    return {"type": block.type}  # thinking: we note that it took place, not its content


def _results_received(request: dict) -> list[dict]:
    """The tool results sent with this call: the shop's answer at the previous turn."""
    last = request["messages"][-1]
    if last["role"] != "user" or isinstance(last["content"], str):
        return []
    return [{"error": bool(b.get("is_error")), "content": str(b.get("content"))[:300]}
            for b in last["content"] if isinstance(b, dict) and b.get("type") == "tool_result"]


class Recorder:
    """Presents itself as the SDK's client (client.messages.create) and keeps a trace of each call."""

    def __init__(self, client):
        self._client = client
        self.messages = self
        self.calls: list[dict] = []
        self._lock = threading.Lock()

    def count_tokens(self, **request):
        return self._client.messages.count_tokens(**request)

    def create(self, **request):
        start = time.perf_counter()
        message = self._client.messages.create(**request)
        price = cost(request["model"], message.usage)
        with self._lock:
            self.calls.append({
                "model": request["model"],
                "stop": message.stop_reason,
                "duration_s": round(time.perf_counter() - start, 2),
                "cost_dollars": round(price.dollars, 6),
                "tokens": {"input": price.input, "cache_write": price.cache_write,
                           "cache_read": price.cache_read, "output": price.output, "thinking": price.thinking},
                "received": _results_received(request),
                "returned": [_block_summary(b) for b in message.content],
            })
        return message


@dataclass
class Trial:
    variant: str
    case: str
    trial: int
    category: str = ""
    text: str = ""                       # what the customer reads, summary included
    claude_text: str = ""                # the part written by Claude, without the code's summary
    summaries: list[dict] = field(default_factory=list)     # status and total, read in the shop
    requests: list[str] = field(default_factory=list)       # reasons of the requests passed on to Awa
    orders: int = 0
    tools: list[str] = field(default_factory=list)
    steps: list[dict] = field(default_factory=list)
    calls: list[dict] = field(default_factory=list)
    cost_dollars: float = 0.0
    latency_s: float = 0.0
    error: str | None = None

    @property
    def identifier(self) -> str:
        return f"{self.variant}/{self.case}/{self.trial}"

    def to_dict(self) -> dict:
        return asdict(self)


def environment(seed: int = 17) -> Shop:
    """A fresh shop: stock of chapter 9, stopped clock, reproducible confirmation codes."""
    return Shop(":memory:", clock=lambda: TRIAL_TIME, rng=random.Random(seed))


def run_trial(client, variant: Variant, case: dict, number: int, base) -> Trial:
    recorder, shop, conversation = Recorder(client), environment(), uuid.uuid4().hex
    comptoir = RoutedComptoir(recorder, shop, Budget(":memory:"), conversation, base,
                              comptoir_model=variant.comptoir_model, prompt_version=variant.prompt_version,
                              documents_version=variant.documents_version, comptoir_effort=variant.comptoir_effort)
    trial = Trial(variant.name, case["id"], number)
    start = time.perf_counter()
    try:
        reply = comptoir.answer(case["message"])
        trial.category, trial.text = reply.category, reply.text
        trial.steps = [asdict(s) for s in reply.trace.steps]
    except ComptoirError as error:
        trial.error = f"{error.diagnostic.code} ({error.diagnostic.origin})"
    except Exception as error:  # a failure of the harness or of the code: the trial fails, the series goes on
        trial.error = f"{type(error).__name__}: {error}"
    trial.latency_s = round(time.perf_counter() - start, 2)
    trial.claude_text = trial.text.split(SUMMARY_START)[0]
    trial.summaries = [{"status": status, "total": total} for _, status, total, _ in shop.summaries(conversation)]
    trial.requests = [reason for _, _, reason, _ in shop.requests()]
    trial.orders = len(shop.orders())
    trial.calls = recorder.calls
    trial.tools = [b["name"] for c in recorder.calls for b in c["returned"] if b["type"] == "tool_use"]
    trial.cost_dollars = round(sum(c["cost_dollars"] for c in recorder.calls), 6)
    return trial
