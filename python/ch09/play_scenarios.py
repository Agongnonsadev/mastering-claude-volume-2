"""Chapter 9: play the 10 order scenarios, and check by code what must be checked.

Each scenario starts from a fresh shop, in memory. The code checks: the number of
orders created, the tools called, the requests passed on to Awa, the absence of an
invented product, and that no message from Claude announces a recorded order. The rest is
reread: the script shows each exchange.

Run, from the python/ folder:
    python -m ch09.play_scenarios --max-budget 0.5
    python -m ch09.play_scenarios --only discount quote
"""

import argparse
import json
import re
import uuid
from pathlib import Path

from comptoir.budget import Budget
from comptoir.call import make_client
from comptoir.errors import ComptoirError
from comptoir.orders import ComptoirOrders
from comptoir.shop import Shop

SCENARIOS = Path(__file__).parent / "scenarios.json"

# Claude must never announce an order as done: only the code does, after the customer's code.
# The French forms too: the Comptoir answers in French a customer who writes in French.
FORBIDDEN_ANNOUNCEMENT = re.compile(
    r"order\s+(?:\S+\s+){0,3}?(?:is|has been|was)?\s*(?:now\s+)?(?:recorded|confirmed|validated|created|placed)|"
    r"commande\s+(?:\S+\s+){0,3}?(?:est|a été|bien)?\s*(?:enregistrée|confirmée|validée|créée)",
    re.IGNORECASE)
_NEGATION = re.compile(r"\b(not|n't|pas)\b", re.IGNORECASE)


def load() -> list[dict]:
    return json.loads(SCENARIOS.read_text(encoding="utf-8"))


def replace_codes(message: str, shop: Shop, conversation: str) -> str | None:
    summaries = shop.summaries(conversation)
    if "{code}" in message or "{first_code}" in message:
        if not summaries:
            return None
        return message.replace("{code}", summaries[-1][0]).replace("{first_code}", summaries[0][0])
    return message


def check(scenario: dict, shop: Shop, conversation: str, calls: list[str], claude_texts: list[str]) -> list[str]:
    """The gaps between what happened and what was expected. Empty list: passed."""
    expected, gaps = scenario["expected"], []
    orders = [o for o in shop.orders() if o[2] == conversation]
    if len(orders) != expected.get("orders", 0):
        gaps.append(f"{len(orders)} order(s) created, {expected.get('orders', 0)} expected")
    for tool in expected.get("required_tools", []):
        if tool not in calls:
            gaps.append(f"tool {tool} never called")
    products = {l["product"] for _, _, _, lines in shop.summaries(conversation) for l in json.loads(lines)}
    for forbidden in expected.get("forbidden_products", []):
        if forbidden in products:
            gaps.append(f"invented product in a summary: {forbidden}")
    if "passed_on" in expected:
        reasons = [r[2] for r in shop.requests() if r[1] == conversation]
        if expected["passed_on"] is None and reasons:
            gaps.append(f"passed on to Awa for no reason: {reasons}")
        if expected["passed_on"] and expected["passed_on"] not in reasons:
            gaps.append(f"request “{expected['passed_on']}” not passed on (passed on: {reasons})")
    if expected.get("first_summary_replaced"):
        summaries = shop.summaries(conversation)
        if len(summaries) < 2 or summaries[0][1] != "replaced":
            gaps.append("the first summary was not replaced")
    for text in claude_texts:
        if announces_an_order(text):
            gaps.append(f"Claude announces a recorded order: “{text[:80]}”")
    return gaps


def announces_an_order(text: str) -> bool:
    """“Your order is recorded”: yes. “It is not recorded yet”: no."""
    return any(not _NEGATION.search(m.group(0)) for m in FORBIDDEN_ANNOUNCEMENT.finditer(text))


def play(client, scenario: dict, budget: Budget) -> list[str]:
    shop, conversation = Shop(), uuid.uuid4().hex
    comptoir = ComptoirOrders(client, shop, budget, conversation)
    calls, claude_texts = [], []
    print(f"\n=== {scenario['id']}")
    for message in scenario["messages"]:
        message = replace_codes(message, shop, conversation)
        if message is None:
            return ["no summary: the confirmation code does not exist"]
        print(f"Customer: {message}")
        try:
            answer = comptoir.answer(message)
        except ComptoirError as error:
            return [f"error: {error.diagnostic.code}"]
        print(f"Comptoir: {answer.text}")
        if answer.turn:
            calls += answer.turn.execution.calls
            claude_texts.append(answer.turn.text)  # the summary added by the code is not part of it
    return check(scenario, shop, conversation, calls, claude_texts)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--max-budget", type=float, default=0.5, help="maximum spending of the series, in dollars")
    parser.add_argument("--only", nargs="*", help="IDs of the scenarios to play")
    args = parser.parse_args()

    from comptoir import config  # a budget dedicated to the series: daily and customer ceilings = max-budget
    config.DAILY_BUDGET = config.CUSTOMER_DAILY_QUOTA = args.max_budget
    budget, client = Budget(), make_client()
    report = {}
    for scenario in load():
        if args.only and scenario["id"] not in args.only:
            continue
        report[scenario["id"]] = play(client, scenario, budget)
    print(f"\n=== Report (spent: ${budget.for_day():.4f})")
    for scenario_id, gaps in report.items():
        print(f"{'passed' if not gaps else 'FAILED'}  {scenario_id}" + "".join(f"\n         - {g}" for g in gaps))


if __name__ == "__main__":
    main()
