"""The Comptoir's system prompt: a versioned file, filled in by the code (chapter 5).

The instructions live in comptoir/prompts/system_vN.md; the data (catalog,
terms) in comptoir/data/delices_awa.json. The code assembles the two: a price
is written in one place only.
"""

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from string import Template

FOLDER = Path(__file__).parent
DEFAULT_VERSION = "v1"


@dataclass(frozen=True)
class SystemPrompt:
    text: str
    version: str

    @property
    def fingerprint(self) -> str:
        """8 characters that change as soon as a single character of the prompt changes."""
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()[:8]

    @property
    def id(self) -> str:
        return f"system-{self.version}@{self.fingerprint}"


def load_data(path: Path = FOLDER / "data" / "delices_awa.json") -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _fcfa(amount: int) -> str:
    """1000 -> “1,000 FCFA”."""
    return f"{amount:,} FCFA"


def render_catalog(data: dict) -> str:
    return "\n".join(f"- {p['name']}: {_fcfa(p['price_fcfa'])} per {p['format']}" for p in data["products"])


def render_terms(data: dict) -> str:
    return "\n".join(f"- {t}" for t in data["terms"])


def load(version: str = DEFAULT_VERSION, data: dict | None = None) -> SystemPrompt:
    template = Template((FOLDER / "prompts" / f"system_{version}.md").read_text(encoding="utf-8"))
    data = data or load_data()
    text = template.substitute(catalog=render_catalog(data), terms=render_terms(data))
    return SystemPrompt(text.strip(), version)


# --- The customer's message: data, never an instruction -----------------------

MAX_LENGTH = 2000
_TAG = re.compile(r"<\s*/?\s*customer_message\s*>", re.IGNORECASE)
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def sanitize(text: str, max_length: int = MAX_LENGTH) -> str:
    """Removes what could make the customer's text break out of its tag, and caps it."""
    text = _CONTROL.sub("", text)
    text = _TAG.sub("", text)
    return text.strip()[:max_length]


def customer_message(text: str) -> str:
    return f"<customer_message>\n{sanitize(text)}\n</customer_message>"
