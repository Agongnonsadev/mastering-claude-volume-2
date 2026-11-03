"""Chapter 12: does Claude Haiku 5.5 think when told not to? Seven requests, one question.

The same question, asked seven times of Claude Haiku 5.5 with max_tokens 1,000: without a document, with
Awa's base as search_result blocks (citations on or off), then as raw text. We record the
thinking tokens and the stop reason. Cost: less than a cent.

Run, from the python/ folder:  python -m ch12.thinking_and_citations
"""

import anthropic

from comptoir import doc_assistant
from comptoir.costs import cost
from comptoir.knowledge import load_knowledge
from comptoir.log import log_call
from comptoir.prompt import customer_message

MODEL = "claude-haiku-5-5"
QUESTION = "I confirm my order on Saturday at 3 p.m.: when will I be delivered?"


def cases(base) -> list[tuple[str, dict]]:
    def documents(citations: bool, effort: str | None = None, disabled: bool = True) -> dict:
        r = doc_assistant.build_request(QUESTION, base, cache="1h", model=MODEL, max_tokens=1000,
                                        no_thinking=disabled, with_citations=citations)
        if effort:
            r["output_config"] = {"effort": effort}
        return r

    alone = {"model": MODEL, "max_tokens": 1000, "system": doc_assistant.load_prompt().text,
             "messages": [{"role": "user", "content": customer_message(QUESTION)}]}
    text = "\n\n".join(f"## {c.title}\n{c.text}" for c in base)
    raw = {**alone, "messages": [{"role": "user", "content": f"<documents>\n{text}\n</documents>\n\n"
                                  + customer_message(QUESTION)}]}
    return [
        ("no document, thinking disabled", {**alone, "thinking": {"type": "disabled"}}),
        ("no document, effort low", {**alone, "output_config": {"effort": "low"}}),
        ("search_result with citations, disabled", documents(True)),
        ("search_result with citations, effort low", documents(True, "low", disabled=False)),
        ("search_result with citations, disabled and low", documents(True, "low")),
        ("search_result without citations, disabled", documents(False)),
        ("base as raw text, disabled", {**raw, "thinking": {"type": "disabled"}}),
    ]


def main() -> None:
    client, total = anthropic.Anthropic(), 0.0
    for name, request in cases(load_knowledge()):
        response = client.messages.create(**request)
        price = cost(MODEL, response.usage)
        total += price.dollars
        log_call(response._request_id, MODEL, price, prompt="ch12-thinking", stop_reason=response.stop_reason)
        thinking = getattr(response.usage.output_tokens_details, "thinking_tokens", 0) or 0
        print(f"{name:50} thinking {thinking:>4} tokens  output {response.usage.output_tokens:>4}  "
              f"stop {response.stop_reason}")
    print(f"\nCost: ${total:.4f}")


if __name__ == "__main__":
    main()
