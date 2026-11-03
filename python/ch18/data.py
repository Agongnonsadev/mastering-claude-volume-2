"""Chapter 18: the customers' data, kept for the promised time, erased on request.

From the python/ folder (FREE, no call to the API):
    python -m ch18.data purge                              the periods of config.py, on both databases
    python -m ch18.data erase <conversation>               what a customer asked to erase
    python -m ch18.data erase-number <number>              the same for a WhatsApp customer (chapter 21)

`purge` is to be run every day: the web server does it for the conversations (comptoir/web.py); for
the shop, a scheduled task of the server takes care of it (chapter 19). `erase` is used when a customer
asks for it: the Comptoir cannot erase anything itself (no tool allows it), it passes the request on to
Awa, who runs the command. Past orders remain, reduced to the customer's first name and initial:
the accounts need them. The time to answer depends on the law of the customer's country.
"""

import argparse
import json
import sys

from comptoir import config, whatsapp
from comptoir.conversations import Conversations
from comptoir.shop import Shop


def purge(shop: Shop, conversations: Conversations, directory: whatsapp.Directory) -> dict:
    result = shop.purge(config.REQUEST_RETENTION_DAYS, config.NAME_RETENTION_DAYS, config.SUMMARY_RETENTION_DAYS)
    result["conversations_erased"] = conversations.purge()
    result["whatsapp_customers_forgotten"] = directory.purge(config.RETENTION_DAYS)
    return result


def erase(shop: Shop, conversations: Conversations, directory: whatsapp.Directory, conversation: str) -> dict:
    result = shop.erase(conversation)
    result["conversation_erased"] = conversations.erase(conversation)
    # Chapter 21: the WhatsApp number too, which remained in the directory of chapter 19.
    result["number_erased"] = directory.erase(conversation) > 0
    return result


def erase_number(shop: Shop, conversations: Conversations, directory: whatsapp.Directory, number: str) -> dict:
    """A WhatsApp customer gives their number, not a conversation ID: it is found through the fingerprint."""
    conversation = directory.conversation(whatsapp.pseudonym(number, config.PSEUDONYM_SALT))
    if conversation is None:
        return {"conversation_found": False}
    return {"conversation_found": True, **erase(shop, conversations, directory, conversation)}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("purge")
    p = commands.add_parser("erase")
    p.add_argument("conversation")
    p = commands.add_parser("erase-number")
    p.add_argument("number", help="in WhatsApp's format, without + or spaces: 22997000000")
    args = parser.parse_args()
    shop, conversations = Shop(config.SHOP), Conversations(config.CONVERSATIONS)
    directory = whatsapp.Directory(config.CONVERSATIONS)  # the directory lives in the conversations database
    if args.command == "purge":
        result = purge(shop, conversations, directory)
    elif args.command == "erase":
        result = erase(shop, conversations, directory, args.conversation)
    else:
        result = erase_number(shop, conversations, directory, args.number)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
