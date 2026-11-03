"""Chapter 21: the Comptoir's watch. What changes at Anthropic without the Comptoir's code moving.

From the python/ folder:
    python -m ch21.watch                    (free: the Models API generates nothing and consumes no token)
    python -m ch21.watch --horizon 180      (alert if a model in use is retired within 180 days)

Three questions, every week, in CI:
1. Are the models the Comptoir calls still active, and until when? Two sources, crossed:
   the Model deprecations page (the published state, the retirement date or “not sooner than…”) and the Models API
   (what the key sees). On October 22, 2026, the API said “active” for a model that the page announced retired on
   November 30: a single source would not have been enough. Anthropic warns at least 60 days before the retirement
   of a published model.
2. Is the installed SDK up to date? sdk-versions.json gives the latest version of each SDK. One more major
   version means, since 2.0.0 of the Python SDK, a new version of the API.
3. Which version of the API does the Comptoir send (anthropic-version header)?

The exit code is 1 if there is an alert: the scheduled CI job fails, and someone looks.
"""

import argparse
import importlib.metadata
import json
import re
import sys
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import anthropic

from comptoir import config

ROOT = Path(__file__).resolve().parents[1]
DEPRECATIONS_PAGE = "https://platform.claude.com/docs/en/about-claude/model-deprecations.md"
SDK_VERSIONS = "https://platform.claude.com/docs/sdk-versions.json"
AGENT = {"User-Agent": "comptoir-watch/1.0"}  # the site refuses Python's default client (403)
MODEL = re.compile(r"\bclaude-(?:fable|mythos|opus|sonnet|haiku)-\d+(?:-\d+)?(?:-\d{8})?\b")
SETTINGS = ("MODEL", "ROUTER_MODEL", "DOCUMENTS_MODEL", "AUXILIARY_MODEL", "COMPTOIR_MODEL")
TABLE_ROW = re.compile(r"^\|\s*(claude-[a-z0-9-]+)\s*\|\s*([A-Za-z]+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|$", re.M)


@dataclass
class State:
    """What the deprecations page says about a model."""
    state: str                      # Active, Legacy, Deprecated, Retired
    deprecated_on: str | None
    retirement: datetime | None     # the date set, or the one before which there will be no retirement
    not_before: bool                # “Not sooner than”: a floor date, not a set date


@dataclass
class Report:
    alerts: list[str] = field(default_factory=list)
    infos: list[str] = field(default_factory=list)

    def text(self) -> str:
        return "\n".join([f"ALERT   {a}" for a in self.alerts] + [f"        {i}" for i in self.infos]) or "Nothing to report."


def read_date(text: str) -> datetime | None:
    try:
        return datetime.strptime(text.strip(), "%B %d, %Y").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def published_states(page: str) -> dict[str, State]:
    """The “Model status” table of the deprecations page, in Markdown."""
    states = {}
    for model_id, state, deprecated, retirement in TABLE_ROW.findall(page):
        floor = retirement.lower().startswith("not sooner than")
        date = read_date(re.sub(r"(?i)^not sooner than\s+", "", retirement))
        states[model_id] = State(state, None if deprecated in ("N/A", "") else deprecated, date, floor)
    return states


def download(url: str) -> str | None:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=AGENT), timeout=20) as response:
            return response.read().decode("utf-8")
    except OSError:
        return None


def models_in_production() -> dict[str, str]:
    """Setting -> model, as comptoir/config.py reads them (environment variables included)."""
    return {name: getattr(config, name) for name in SETTINGS}


def models_of_the_repository(root: Path = ROOT) -> dict[str, set[str]]:
    """Model -> files where it is written, except results, tests, virtual environments and this file."""
    found: dict[str, set[str]] = {}
    for file in root.rglob("*.py"):
        relative = file.relative_to(root).as_posix()
        if relative.startswith((".venv", "tests/")) or "/results/" in relative or file.resolve() == Path(__file__).resolve():
            continue
        for model in set(MODEL.findall(file.read_text(encoding="utf-8", errors="replace"))):
            found.setdefault(model, set()).add(relative)
    return found


def find(models: dict, model_id: str):
    """The exact model, or the dated version whose ID is an alias (…-4-5 -> …-4-5-20251001)."""
    if model_id in models:
        return models[model_id]
    dated = [m for i, m in models.items() if i.startswith(model_id + "-")]
    return dated[0] if len(dated) == 1 else None


def examine_models(catalog: dict, published: dict[str, State] | None, used: dict[str, str], horizon_days: int,
                   now: datetime) -> Report:
    """catalog: ID -> model of the Models API; published: the deprecations page (None if unreachable)."""
    report = Report()
    if published is None:
        report.alerts.append("Deprecations page unreachable: only the Models API was read")
    for model_id in sorted(set(used.values())):
        where = ", ".join(sorted(k for k, v in used.items() if v == model_id))
        api, page = find(catalog, model_id), find(published or {}, model_id)
        if api is None:
            report.alerts.append(f"{model_id} ({where}): missing from the Models API — retired, or not accessible with this key")
        if page is not None and page.state != "Active":
            when = f", retirement on {page.retirement.date().isoformat()}" if page.retirement and not page.not_before else ""
            report.alerts.append(f"{model_id} ({where}): “{page.state}” according to the deprecations page{when}")
            if api is not None and api.lifecycle == "active":
                report.alerts.append(f"{model_id}: the Models API still says “active”; the page is authoritative")
            continue
        if api is not None and api.lifecycle != "active":
            report.alerts.append(f"{model_id} ({where}): “{api.lifecycle}” according to the Models API")
            continue
        retirement = getattr(api, "retires_at", None) or (page.retirement if page and not page.not_before else None)
        if retirement and retirement - now <= timedelta(days=horizon_days):
            report.alerts.append(f"{model_id} ({where}): retirement on {retirement.date().isoformat()}, "
                                 f"in {(retirement - now).days} days")
        elif api is not None:
            floor = f", not before {page.retirement.date().isoformat()}" if page and page.not_before and page.retirement else ""
            report.infos.append(f"{model_id} ({where}): active{floor}")
    return report


def major(version: str) -> int:
    return int(version.split(".")[0])


def examine_sdk(installed: str, latest: str | None, api_version: str) -> Report:
    report = Report()
    if latest is None:
        report.alerts.append("Latest SDK version unknown: sdk-versions.json unreachable")
    elif major(latest) > major(installed):
        report.alerts.append(f"anthropic SDK {installed} installed, {latest} available: one more major version, "
                             "hence a new API version. Read the migration guide before changing.")
    elif latest != installed:
        report.infos.append(f"anthropic SDK {installed} installed, {latest} available (same major version)")
    else:
        report.infos.append(f"anthropic SDK {installed}: up to date")
    report.infos.append(f"API version sent: {api_version}")
    return report


def api_version_sent() -> str:
    """The anthropic-version header that the installed SDK sends by default (no request is made)."""
    return anthropic.Anthropic(api_key="none").default_headers.get("anthropic-version", "?")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--horizon", type=int, default=120, help="days before a retirement to raise an alert")
    args = parser.parse_args()
    now = datetime.now(timezone.utc)

    from comptoir.call import make_client
    page = download(DEPRECATIONS_PAGE)
    published = published_states(page) if page else None
    production = models_in_production()
    catalog = {m.id: m for m in make_client().models.list()}
    report = examine_models(catalog, published, production, args.horizon, now)
    versions = download(SDK_VERSIONS)
    sdk = examine_sdk(importlib.metadata.version("anthropic"), json.loads(versions).get("python") if versions else None,
                      api_version_sent())
    print(f"Watch of {now:%B} {now.day}, {now.year}\n\nThe Comptoir's models in production:\n{report.text()}\n")
    print("SDK and API:\n" + sdk.text() + "\n")
    others = {m: f for m, f in models_of_the_repository().items() if m not in production.values()}
    if others:
        print("Other models written in the repository (chapter scripts, comparisons):")
        for model, files in sorted(others.items()):
            state = find(published or {}, model)
            print(f"        {model} ({state.state if state else 'unknown state'}): {', '.join(sorted(files))}")
    return 1 if report.alerts or sdk.alerts else 0


if __name__ == "__main__":
    raise SystemExit(main())
