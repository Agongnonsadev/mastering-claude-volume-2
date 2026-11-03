"""Chapter 8: the Comptoir on the command line, with its budget and its diagnoses.

Run, from the python/ folder:
    python -m ch08.robust_comptoir "How much are 6 bottles of bissap?" --customer trial-1
"""

import argparse

from comptoir import assistant, config
from comptoir.budget import Budget
from comptoir.call import call_claude, make_client
from comptoir.errors import ComptoirError
from comptoir.prompt import load


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("question")
    parser.add_argument("--customer", default="trial", help="the customer's ID, for their daily quota")
    args = parser.parse_args()

    budget = Budget(config.BUDGET_DB)
    prompt = load()
    request = assistant.build_request(args.question, prompt=prompt)
    try:
        reply = call_claude(make_client(), request, budget, args.customer, prompt=prompt.id)
    except ComptoirError as error:
        print(f"To the customer: {error.diagnostic.for_customer}")
        print(f"For Yao:         {error.diagnostic.for_yao}")
        return
    if reply.stop and reply.stop.code == "refusal":
        print(reply.stop.for_customer)  # any beginning of an answer is to be thrown away
    else:
        print(reply.text)
    if reply.stop:
        print(f"For Yao:         {reply.stop.for_yao}")
    print(f"\n[{reply.cost}]; spent today: ${budget.for_day():.4f} of ${config.DAILY_BUDGET:.2f}")
    if reply.alert:
        print("⚠ Alert threshold crossed: the daily or monthly budget is approaching its ceiling.")


if __name__ == "__main__":
    main()
