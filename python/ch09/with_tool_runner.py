"""Chapter 9: the same tool loop, handed to the SDK's Tool Runner (in beta).

The @beta_tool decorator draws the tool's schema from the type annotations and the
docstring; the runner calls Claude, runs the tools, sends back the results and
starts again, until an answer without a tool call, or until max_iterations.

Run, from the python/ folder:  python -m ch09.with_tool_runner
"""

import json

import anthropic
from anthropic import beta_tool

from comptoir import config
from comptoir.costs import cost
from comptoir.prompt import load
from comptoir.shop import Shop

shop = Shop()  # in memory: the chapter's fictional stock, nothing is written


@beta_tool
def stock_check(products: list[str]) -> str:
    """Gives the quantity available today for products in the Délices d'Awa catalog.

    Use it when a customer asks whether a product is available. The names must be
    those of the catalog, exactly. Returns neither prices nor delivery times.

    Args:
        products: The exact names of the catalog products to check.
    """
    return json.dumps({p: shop.available(p) if p in shop.catalog else "missing from the catalog"
                       for p in products}, ensure_ascii=False)


def main() -> None:
    client = anthropic.Anthropic()
    runner = client.beta.messages.tool_runner(
        model=config.MODEL,
        max_tokens=2000,
        max_iterations=4,  # a bound, like MAX_TURNS in the hand-written loop
        system=load("v2").text,
        tools=[stock_check],
        messages=[{"role": "user", "content": "Do you have any pineapple juice and soursop juice left?"}],
    )
    for message in runner:  # one message per call to Claude
        types = [block.type for block in message.content]
        # The cost is displayed, but nothing records it: neither budget nor log, unlike the Comptoir.
        print(f"[{message.stop_reason}] {types} {cost(config.MODEL, message.usage)}")
    final = runner.until_done()
    print("\n" + "".join(b.text for b in final.content if b.type == "text"))


if __name__ == "__main__":
    main()
