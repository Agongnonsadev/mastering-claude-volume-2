"""Chapter 2: count the tokens of the same message in several languages, before sending it.

Counting is free (it only has its own rate limit).
Run, from the python/ folder:
    python -m ch02.count_tokens
    python -m ch02.count_tokens "The same sentence in your local language"
"""

import sys

import anthropic

MODEL = "claude-sonnet-5-5"

# The same order in French, the language of most of Awa's customers, and in English.
sentences = {
    "French": (
        "Bonjour, je voudrais commander deux bouteilles de jus de bissap "
        "et un sirop de gingembre, livrés demain matin à Cotonou."
    ),
    "English": (
        "Hello, I would like to order two bottles of bissap juice "
        "and one ginger syrup, delivered tomorrow morning in Cotonou."
    ),
}
if len(sys.argv) > 1:
    sentences["other language"] = " ".join(sys.argv[1:])

client = anthropic.Anthropic()

for language, sentence in sentences.items():
    count = client.messages.count_tokens(
        model=MODEL,
        messages=[{"role": "user", "content": sentence}],
    )
    print(f"{language:<14} {len(sentence):>4} characters   {count.input_tokens:>4} tokens")
