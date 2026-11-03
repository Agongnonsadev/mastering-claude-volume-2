// Chapter 21: estimate what an assistant like the Comptoir will cost a client, each month.
//
// From the typescript/ folder (free, no call):
//     npx tsx ch21/estimate_project.ts --messages 1500 --whatsapp --hosting 7
//     npx tsx ch21/estimate_project.ts --messages 1500 --message-cost 0.0009
//
// An estimate, not a measurement: it starts from the unit prices measured in this book, for an application that
// resembles the Comptoir (Claude Haiku 5.5, tools, cache, complaints drafted by Claude Sonnet 5.5). For another
// application, first measure its cost per message (chapter 19), then pass it as --message-cost.
// The hosting was not measured in this book: it is up to you to give it.

import { parseArgs } from "node:util";
import { fixed } from "../comptoir/rounding.ts";
import { isMain } from "../comptoir/launch.ts";
import { percent } from "../ch17/suite.ts";

// Chapter 19: eight typical conversations, three trials, on October 22, 2026 ($0.00075 per message).
export const COST_PER_MESSAGE = 0.00075;
// Chapter 19: rate of a WhatsApp service message, “Rest of Africa” region, read on October 22, 2026,
// and the 1,000 free service messages per month and per number.
export const WHATSAPP_RATE = 0.004;
export const WHATSAPP_FREE = 1000;
export const MARGIN = 0.5; // chapter 1: half again, for what the measurement did not see (peaks, long conversations)

export interface Estimate {
  claude: number;
  claudeWithMargin: number;
  whatsapp: number;
  hosting: number | null;
  total: number | null;
}

export function estimate(messages: number, { messageCost = COST_PER_MESSAGE, whatsapp = false, whatsappRate = WHATSAPP_RATE, hosting = null as number | null } = {}): Estimate {
  const claude = messages * messageCost;
  const channel = whatsapp ? Math.max(0, messages - WHATSAPP_FREE) * whatsappRate : 0;
  const claudeWithMargin = claude * (1 + MARGIN);
  return { claude, claudeWithMargin, whatsapp: channel, hosting, total: hosting === null ? null : claudeWithMargin + channel + hosting };
}

export function toText(e: Estimate, messages: number): string {
  const line = (name: string, dollars: number | null): string =>
    dollars === null ? `${name.padEnd(38)} [to be measured]` : `${name.padEnd(38)}${("$" + fixed(dollars, 2)).padStart(7)}`;
  const lines = [
    `For ${messages.toLocaleString("en-US")} messages a month:`,
    line("Claude (measured unit price)", e.claude),
    line(`Claude, with a ${percent(MARGIN)} margin`, e.claudeWithMargin),
    line("WhatsApp (service messages)", e.whatsapp),
    line("Hosting", e.hosting),
    line("Total per month", e.total),
  ];
  if (e.total !== null && messages) lines.push(`${"Per message".padEnd(38)}${("$" + fixed(e.total / messages, 4)).padStart(7)}`);
  return lines.join("\n");
}

function main(): void {
  const { values: args } = parseArgs({
    options: {
      messages: { type: "string" }, //                                       customer messages per month
      "message-cost": { type: "string", default: String(COST_PER_MESSAGE) }, // in dollars, measured for your application
      whatsapp: { type: "boolean", default: false }, //                       the customers write on WhatsApp
      "whatsapp-rate": { type: "string", default: String(WHATSAPP_RATE) }, //  in dollars, for your country
      hosting: { type: "string" }, //                                         in dollars per month
    },
  });
  if (!args.messages) {
    console.error("--messages is required: the customer messages per month.");
    process.exit(2);
  }
  const messages = Number(args.messages);
  console.log(toText(estimate(messages, {
    messageCost: Number(args["message-cost"]), whatsapp: args.whatsapp, whatsappRate: Number(args["whatsapp-rate"]),
    hosting: args.hosting === undefined ? null : Number(args.hosting),
  }), messages));
}

if (isMain(import.meta.url)) main();
