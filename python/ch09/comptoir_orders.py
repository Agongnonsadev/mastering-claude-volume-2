"""Chapter 9: talk to the Comptoir in the terminal, and place an order with it.

Run, from the python/ folder:  python -m ch09.comptoir_orders
Type your messages as a customer; an empty line to quit. To confirm a
summary, reply “YES” followed by the code shown.

The shop (stock, summaries, orders) lives in customer_data/shop.sqlite3.
"""

import uuid

from comptoir import config
from comptoir.budget import Budget
from comptoir.call import make_client
from comptoir.errors import ComptoirError
from comptoir.orders import ComptoirOrders
from comptoir.shop import Shop

SHOP = "customer_data/shop.sqlite3"


def main() -> None:
    comptoir = ComptoirOrders(make_client(), Shop(SHOP), Budget(config.BUDGET_DB), uuid.uuid4().hex)
    print("Awa's Comptoir — an empty line to quit.\n")
    while text := input("You: ").strip():
        try:
            answer = comptoir.answer(text)
        except ComptoirError as error:
            print(f"Comptoir: {error.diagnostic.for_customer}\n  (for Yao: {error.diagnostic.for_yao})\n")
            continue
        print(f"Comptoir: {answer.text}\n")
        if answer.turn and answer.turn.execution.calls:
            print(f"  (tools called: {', '.join(answer.turn.execution.calls)})\n")


if __name__ == "__main__":
    main()
