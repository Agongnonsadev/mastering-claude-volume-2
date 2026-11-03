"""Chapter 2: the Comptoir on the command line. It answers a customer's question
and shows what the answer cost.

Run, from the python/ folder:
    python -m ch02.comptoir_cli "How much is the ginger syrup?"
"""

import sys

import anthropic

from comptoir import config
from comptoir.costs import Cost, cost
from comptoir.log import log_call

# Version 0 of the system prompt: the bare minimum. Chapter 5 rewrites it.
SYSTEM_PROMPT = """You are the Comptoir, the assistant of Délices d'Awa, a business making natural juices and craft syrups in Cotonou (fictional business).

Current information:
- Bissap, ginger, pineapple and soursop juice: 1,000 FCFA for a 500 ml bottle.
- Syrups (bissap, ginger): 2,500 FCFA a bottle.
- Orders through WhatsApp, from 8 a.m. to 7 p.m.
- Delivery in Cotonou: the same day for any order placed before 12 p.m., otherwise the next day. Free from 5 bottles, 500 FCFA below that.
- Payment: Mobile Money (MTN MoMo, Moov Money) or cash on delivery.

Answer in English, in three sentences at most. If the answer is not in this information, say so and offer to pass the question on to Awa."""


def answer(client, question: str, model: str = config.MODEL) -> tuple[str, Cost, object]:
    """Sends the question to the model and returns the text, the cost and the full message."""
    message = client.messages.create(
        model=model,
        max_tokens=1000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": question}],
    )
    text = "".join(block.text for block in message.content if block.type == "text")
    price = cost(model, message.usage)
    log_call(message._request_id, model, price)
    return text, price, message


def main() -> None:
    question = " ".join(sys.argv[1:]) or input("Customer's question: ")
    text, price, message = answer(anthropic.Anthropic(), question)
    print(text)
    print()
    print(
        f"[{price.input} input tokens, {price.output} output tokens "
        f"({price.thinking} of them thinking). Cost: {price}]"
    )
    if message.stop_reason != "end_turn":
        print(f"[Warning: answer stopped for the reason “{message.stop_reason}”]")


if __name__ == "__main__":
    main()
