"""The tool loop, written by hand (chapter 9).

Claude answers; if it asks for tools (stop_reason “tool_use”), the code runs them and
sends back all the results in a single message; this goes on until a final answer.
Each call goes through comptoir.call: budget, log and diagnoses of chapter 8.
"""

from dataclasses import dataclass, field

from comptoir.budget import Budget
from comptoir.call import call_claude
from comptoir.conversations import to_blocks
from comptoir.errors import UNAVAILABLE, ComptoirError, Diagnostic
from comptoir.tools import Execution, Tools

MAX_TURNS = 6  # beyond that, something is going round in circles: stop rather than pay


@dataclass
class Turn:
    text: str                         # Claude's final answer, for the customer
    new_messages: list[dict]          # to add to the history, in order, without rewriting anything
    execution: Execution = field(default_factory=Execution)
    stop: Diagnostic | None = None
    cost: float = 0.0                 # all the calls of the turn, in dollars (chapter 12)


def converse(client, request: dict, tools: Tools, budget: Budget, customer_id: str,
             prompt: str | None = None, max_turns: int = MAX_TURNS) -> Turn:
    """request: a request of the Comptoir (comptoir.assistant), whose last message is the customer's."""
    messages = list(request["messages"])
    new_messages: list[dict] = []
    execution = Execution()
    total = 0.0
    for _ in range(max_turns):
        reply = call_claude(client, {**request, "messages": messages}, budget, customer_id, prompt)
        total += reply.cost.dollars
        # The assistant message is kept as is: thinking, text and tool calls. In
        # a tool turn, the thinking blocks must come back intact with the results.
        assistant = {"role": "assistant", "content": to_blocks(reply.message.content)}
        messages.append(assistant)
        new_messages.append(assistant)
        if reply.message.stop_reason != "tool_use":
            return Turn(reply.text, new_messages, execution, reply.stop, total)

        calls = [block for block in reply.message.content if block.type == "tool_use"]
        # All the results in ONE message, in the order of the calls, and nothing before them.
        results = {"role": "user", "content": [tools.execute(call, execution) for call in calls]}
        messages.append(results)
        new_messages.append(results)

    raise ComptoirError(Diagnostic("loop_too_long", False, "integration", UNAVAILABLE,
                                   f"More than {max_turns} tool turns for a single message: read the trace."))
