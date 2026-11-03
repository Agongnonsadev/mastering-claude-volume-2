"""Chapter 5: an instruction from Awa added during the conversation, without touching the prompt.

The system prompt does not change (and its cache remains valid, chapter 11): the instruction
arrives as a system message placed right after the customer's message.

Run, from the python/ folder:  python -m ch05.mid_conversation_instruction
"""

import anthropic

from comptoir.assistant import answer

INSTRUCTION = (
    "Information from Awa, valid today only: soursop juice is out of stock "
    "until tomorrow morning. Do not offer it; offer pineapple or ginger instead."
)

client = anthropic.Anthropic()
question = "Hello, I'd like 3 bottles of soursop for this evening."

for instructions in ([], [INSTRUCTION]):
    text, price, _ = answer(client, question, instructions=instructions)
    print("With the instruction:" if instructions else "Without an instruction:")
    print(text)
    print(f"[{price}]\n")
