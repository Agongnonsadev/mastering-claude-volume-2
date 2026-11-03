// Chapter 18: the customers' data, kept for the promised time, erased on request.
//
// From the typescript/ folder (FREE, no call to the API):
//     npx tsx ch18/data.ts purge                            the periods of config.ts, on both databases
//     npx tsx ch18/data.ts erase <conversation>             what a customer asked to erase
//     npx tsx ch18/data.ts erase-number <number>            the same for a WhatsApp customer (chapter 21)
//
// `purge` is to be run every day: the online server does it on its own (comptoir/online.ts), for the three
// databases. `erase` is used when a customer asks for it: the Comptoir cannot erase anything itself (no tool
// allows it), it passes the request on to Awa, who runs the command. Past orders remain, reduced to the
// customer's first name and initial: the accounts need them. The time to answer depends on the law of the
// customer's country.

import { config } from "../comptoir/config.ts";
import { Conversations } from "../comptoir/conversations.ts";
import { isMain } from "../comptoir/launch.ts";
import { pythonJson } from "../comptoir/python.ts";
import { Shop } from "../comptoir/shop.ts";
import * as whatsapp from "../comptoir/whatsapp.ts";

export function purge(shop: Shop, conversations: Conversations, directory: whatsapp.Directory): Record<string, number> {
  return {
    ...shop.purge(config.REQUEST_RETENTION_DAYS, config.NAME_RETENTION_DAYS, config.SUMMARY_RETENTION_DAYS),
    conversations_erased: conversations.purge(),
    whatsapp_customers_forgotten: directory.purge(config.RETENTION_DAYS),
  };
}

export function erase(shop: Shop, conversations: Conversations, directory: whatsapp.Directory, conversation: string): Record<string, number | boolean> {
  return {
    ...shop.erase(conversation),
    conversation_erased: conversations.erase(conversation),
    // Chapter 21: the WhatsApp number too, which remained in the directory of chapter 19.
    number_erased: directory.erase(conversation) > 0,
  };
}

/** A WhatsApp customer gives their number, not a conversation ID: it is found through the fingerprint. */
export function eraseNumber(shop: Shop, conversations: Conversations, directory: whatsapp.Directory, number: string): Record<string, number | boolean> {
  const conversation = directory.conversation(whatsapp.pseudonym(number, config.PSEUDONYM_SALT));
  if (conversation === null) return { conversation_found: false };
  return { conversation_found: true, ...erase(shop, conversations, directory, conversation) };
}

function main(): void {
  const [command, argument] = process.argv.slice(2);
  const shop = new Shop(config.SHOP);
  const conversations = new Conversations(config.CONVERSATIONS);
  const directory = new whatsapp.Directory(config.CONVERSATIONS); // the directory lives in the conversations database
  let result: Record<string, number | boolean>;
  if (command === "purge") result = purge(shop, conversations, directory);
  else if (command === "erase" && argument) result = erase(shop, conversations, directory, argument);
  else if (command === "erase-number" && argument) result = eraseNumber(shop, conversations, directory, argument); // in WhatsApp's format, without + or spaces: 22997000000
  else {
    console.error("Command: purge, erase <conversation> or erase-number <number>.");
    process.exit(2);
  }
  console.log(pythonJson(result));
}

if (isMain(import.meta.url)) main();
