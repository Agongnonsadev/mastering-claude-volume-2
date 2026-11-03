// Chapter 8: the Comptoir on the command line, with its budget and its diagnoses.
//
// Run, from the typescript/ folder:
//     npx tsx ch08/robust_comptoir.ts "How much are 6 bottles of bissap?" --customer trial-1

import { parseArgs } from "node:util";
import { buildRequest } from "../comptoir/assistant.ts";
import { Budget } from "../comptoir/budget.ts";
import { callClaude, makeClient } from "../comptoir/call.ts";
import { config } from "../comptoir/config.ts";
import { ComptoirError } from "../comptoir/errors.ts";
import { load } from "../comptoir/prompt.ts";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { customer: { type: "string", default: "trial" } }, // the customer's ID, for their daily quota
});
const question = positionals.join(" ");
if (!question) throw new Error("Ask a question.");

const budget = new Budget(config.BUDGET_DB);
const prompt = load();
const request = buildRequest(question, { prompt });
try {
  const reply = await callClaude(makeClient(), request, budget, args.customer, prompt.id);
  // A refusal: any beginning of an answer is to be thrown away.
  console.log(reply.stop?.code === "refusal" ? reply.stop.forCustomer : reply.text);
  if (reply.stop) console.log(`For Yao:         ${reply.stop.forYao}`);
  console.log(`\n[${reply.cost}]; spent today: $${budget.forDay().toFixed(4)} of $${config.DAILY_BUDGET.toFixed(2)}`);
  if (reply.alert) console.log("⚠ Alert threshold crossed: the daily or monthly budget is approaching its ceiling.");
} catch (error) {
  if (!(error instanceof ComptoirError)) throw error;
  console.log(`To the customer: ${error.diagnostic.forCustomer}`);
  console.log(`For Yao:         ${error.diagnostic.forYao}`);
}
