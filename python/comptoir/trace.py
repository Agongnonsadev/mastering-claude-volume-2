"""Following each step of a processing: model, duration, cost, result (chapter 12).

One trace per customer message. Each step (routing, extraction, answer…) records in it
what it did, and a line goes into the log, with the trace's ID: we find,
afterwards, why a message took a given path and what it cost.

Like the log, the trace never holds the customer's text: only categories,
codes and numbers.
"""

import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field

from comptoir.log import log_event


@dataclass
class Step:
    name: str
    model: str             # “code” when no model is called
    duration_ms: int = 0
    cost_dollars: float = 0.0
    result: str = ""       # a category, a code, a number: never the customer's text
    error: str | None = None


@dataclass
class Recorder:
    """What the current step fills in: its cost and its result."""
    step: Step

    def record(self, cost: float = 0.0, result: str = "") -> None:
        self.step.cost_dollars += cost
        if result:
            self.step.result = result


@dataclass
class Trace:
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    steps: list[Step] = field(default_factory=list)

    @contextmanager
    def step(self, name: str, model: str = "code"):
        step = Step(name, model)
        start = time.perf_counter()
        try:
            yield Recorder(step)
        except Exception as error:
            step.error = type(error).__name__
            raise
        finally:
            step.duration_ms = round((time.perf_counter() - start) * 1000)
            self._keep(step)

    def add(self, name: str, model: str, duration_ms: int, cost_dollars: float, result: str = "") -> None:
        """A step already measured elsewhere, for example a call made by the Tool Runner (chapter 13)."""
        self._keep(Step(name, model, duration_ms, cost_dollars, result))

    def _keep(self, step: Step) -> None:
        self.steps.append(step)
        log_event("step", trace=self.id, step=step.name, model=step.model,
                  duration_ms=step.duration_ms, cost_dollars=round(step.cost_dollars, 6),
                  result=step.result or None, error=step.error)

    @property
    def cost(self) -> float:
        return sum(s.cost_dollars for s in self.steps)

    @property
    def duration_ms(self) -> int:
        return sum(s.duration_ms for s in self.steps)

    def show(self) -> str:
        lines = [f"trace {self.id}: {len(self.steps)} steps, {self.duration_ms / 1000:.1f} s, ${self.cost:.4f}"]
        for s in self.steps:
            lines.append(f"  {s.name:13} {s.model:18} {s.duration_ms / 1000:>5.1f} s  ${s.cost_dollars:.5f}  "
                         f"{s.result}{'  ERROR ' + s.error if s.error else ''}")
        return "\n".join(lines)
