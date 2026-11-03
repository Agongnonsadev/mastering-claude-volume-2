"""Chapter 7: answer a question about a supplier's terms, citing the passage.

With --files-api, the PDF is sent once to the Files API, then designated by its
ID, then deleted at the end.

Run, from the python/ folder:
    python -m ch07.cite_terms "Within what time must I report a breakage?"
    python -m ch07.cite_terms --files-api "What is the minimum order?" "And the payment term?"
"""

import argparse
from pathlib import Path

import anthropic

from comptoir import config
from comptoir.costs import cost
from comptoir.documents import file_block, pdf_block
from comptoir.log import log_call

PDF = Path(__file__).parent / "documents" / "supplier-terms.pdf"
SYSTEM = (
    "You answer the questions of Yao, from Délices d'Awa, about the terms of his suppliers. "
    "You answer only from the document provided; if it does not contain the answer, say so."
)


def ask(client, document: dict, question: str) -> None:
    request = {
        "model": config.MODEL,
        "max_tokens": 1500,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": [document, {"type": "text", "text": question}]}],
    }
    if config.EFFORT:
        request["output_config"] = {"effort": config.EFFORT}  # never a format: incompatible with citations
    message = client.messages.create(**request)
    price = cost(request["model"], message.usage)
    log_call(message._request_id, request["model"], price)
    print(f"\n{question}")
    for block in message.content:
        if block.type != "text":
            continue
        print(block.text, end="")
        for citation in block.citations or []:
            print(f" [p. {citation.start_page_number}: “{citation.cited_text.strip()}”]", end="")
    print(f"\n({price})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("questions", nargs="+")
    parser.add_argument("--files-api", action="store_true")
    args = parser.parse_args()
    client = anthropic.Anthropic()

    if not args.files_api:
        document = pdf_block(PDF, title="Supplier's terms of sale", citations=True)
        for question in args.questions:
            ask(client, document, question)
        return

    with PDF.open("rb") as f:
        uploaded = client.files.upload(file=(PDF.name, f, "application/pdf"))
    print(f"File sent: {uploaded.id}")
    try:
        document = file_block(uploaded.id, citations=True)
        for question in args.questions:
            ask(client, document, question)
    finally:
        client.files.delete(uploaded.id)  # a file sent stays stored until it is deleted
        print("File deleted.")


if __name__ == "__main__":
    main()
