"""The Comptoir, chapter 5 version: versioned prompt, tagged customer message,
Awa's instructions during the conversation.
"""

from comptoir import config
from comptoir.costs import Cost, cost
from comptoir.log import log_call
from comptoir.prompt import SystemPrompt, customer_message, load

MAX_TOKENS = 2000


def operator_instruction(text: str) -> dict:
    """A system message added during the conversation, with the authority of the system prompt.

    It must immediately follow a user message, and be the last of the
    list or be followed by an assistant answer. It does not break the cache of the beginning.
    """
    return {"role": "system", "content": text}


def attach_knowledge(messages: list[dict], blocks: list[dict] | None) -> list[dict]:
    """Awa's documents at the top of the first message of the conversation (chapter 11).

    They are attached to each request, identically, and never recorded in the history:
    the beginning of the request does not change from one turn to the next, nor from one customer to the next, and it
    can therefore be read from the cache.
    """
    if not blocks or not messages:
        return messages
    first = messages[0]
    content = first["content"]
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    return [{**first, "content": [*blocks, *content]}, *messages[1:]]


def build_request(
    question: str,
    history: list[dict] | None = None,
    instructions: list[str] | None = None,
    prompt: SystemPrompt | None = None,
    cache: bool = False,
    knowledge: list[dict] | None = None,
    model: str | None = None,
    effort: str | None = None,
) -> dict:
    """cache=True (chapter 11): automatic caching, whose breakpoint moves forward with the conversation.
    knowledge: the search_result blocks of Awa's knowledge base (comptoir.knowledge).
    model (chapter 17): a model other than the one in config, to evaluate it; the effort of
    config then no longer applies, since it was chosen for the Comptoir's model.
    effort (chapter 19): the effort of that particular model, if it has been measured; None for its default."""
    prompt = prompt or load()
    messages = list(history or [])
    messages.append({"role": "user", "content": customer_message(question)})
    # Placed right after the customer's message, Awa's instructions apply to its answer.
    messages.extend(operator_instruction(i) for i in instructions or [])
    request = {
        "model": model or config.MODEL,
        "max_tokens": MAX_TOKENS,
        "system": prompt.text,
        "messages": attach_knowledge(messages, knowledge),
    }
    if config.EFFORT and not model:
        request["output_config"] = {"effort": config.EFFORT}
    if effort:
        request["output_config"] = {"effort": effort}
    if cache:
        request["cache_control"] = {"type": "ephemeral"}
    return request


def answer(client, question: str, **options) -> tuple[str, Cost, object]:
    prompt = options.pop("prompt", None) or load()
    request = build_request(question, prompt=prompt, **options)
    message = client.messages.create(**request)
    text = "".join(b.text for b in message.content if b.type == "text")
    price = cost(request["model"], message.usage)
    log_call(message._request_id, request["model"], price, prompt=prompt.id)
    return text, price, message
