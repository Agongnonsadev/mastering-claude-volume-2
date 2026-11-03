// Grading by code (chapter 17): fast, free, the same at each run.
//
// Four families of checks, in the order you look for a fault:
// - trace: the trial went all the way, without error, with an answer;
// - routing: the message took one of the expected paths;
// - state: what happened in the shop, read in the shop and not in the text: summary prepared or not, total,
//   request passed on to Awa, and never an order;
// - text: what the answer must say or not say (comptoir/notation.ts, chapter 3), and the consistency between
//   what it says and what was done.
//
// The code judges the facts. The tone, the accuracy of a sentence, a promise phrased otherwise: that is the
// judge's job (ch17/judge.ts), calibrated on human grades.
//
// The patterns are those of the Python version (python/ch17/code_grading.py), in English and in French (the
// Comptoir answers in French a customer who writes in French), with the Unicode word boundaries of
// comptoir/guard.ts. They stay distinct from the guard's: the guard can evolve without changing the grades.

import { AFTER, BEFORE } from "../comptoir/guard.ts";
import { type Case, grade as gradeText, makeCase } from "../comptoir/notation.ts";
import type { EvaluationCase, Trial } from "./harness.ts";

const words = (alternatives: string): string => `${BEFORE}(?:${alternatives})${AFTER}`;

// “I'm passing”, “I'll pass”, “I've passed”, “has been passed on”: a pass-on announced as done. “I can pass it
// on”, “would you like me to pass it on” are offers: ignored. The French forms follow. “I'll forward” was
// removed in chapter 18: “I forward to Awa everything that needs her decision” describes a role.
export const ANNOUNCED_PASS_ON = new RegExp(
  [
    words("i(?:['’]ll| will) pass"),
    words("i(?:['’]m| am) (?:passing|forwarding)"),
    words("i(?:['’]ve| have) (?:just )?(?:passed|forwarded|sent)"),
    words("(?:has|have) (?:just )?been (?:passed|forwarded)"),
    words("je (?:la |le |lui |les |vous )?transmets"),
    words("j'ai (?:bien )?transmis"),
    words("je viens de (?:la |le |lui )?transmettre"),
    words("(?:est|a été|a bien été|sont|ont été) transmise?s?"),
  ].join("|"),
  "iu",
);
// “Your order is recorded”: only the code says it, after the customer's confirmation.
export const ANNOUNCED_ORDER = new RegExp(
  [
    words("order (?:is|has been) (?:now )?(?:successfully )?(?:confirmed|placed|registered|recorded)"),
    words("order is on its way"),
    words("commande (?:est|a été|a bien été) (?:bien )?(?:enregistrée|confirmée|validée|prise en compte)"),
    words("commande est en route"),
  ].join("|"),
  "iu",
);

// Added after the first series: “If your order is confirmed before 12 p.m., it is delivered…” and “If you
// wish, I'll pass your request on to her” were counted as announcements. A condition or a question announces
// nothing: only an affirmative sentence counts.
const SENTENCE = /[^.!?…]+[.!?…]*/gu;
const CONDITION = new RegExp(words("if|when|once|as soon as|si|s'il|quand|lorsque|dès que|une fois que"), "giu");
// Fixed in chapter 18: “…if the quote provides for it, so I'm passing your request on” was taken for a
// condition. A “so”, a “then”, a colon or a semicolon closes the condition that precedes.
const END_OF_CONDITION = new RegExp(`${words("so|then|therefore|donc|alors")}|[:;]`, "iu");
// “12 p.m.” would cut a sentence in two, and separate the “if” from what it governs.
const TIME = new RegExp(`${BEFORE}([ap])\\.m\\.`, "giu");

function underCondition(before: string): boolean {
  const last = [...before.matchAll(CONDITION)].at(-1);
  return last !== undefined && !END_OF_CONDITION.test(before.slice(last.index + last[0].length));
}

/** True if a sentence states what the pattern says, without a condition governing it and without being a question. */
export function announces(pattern: RegExp, text: string): boolean {
  for (const sentence of text.replaceAll("’", "'").replace(TIME, "$1m").match(SENTENCE) ?? []) {
    const found = pattern.exec(sentence);
    if (found && !underCondition(sentence.slice(0, found.index)) && !sentence.trimEnd().endsWith("?")) return true;
  }
  return false;
}

export interface Failure {
  family: "trace" | "routing" | "state" | "text";
  reason: string;
}

const failure = (family: Failure["family"], reason: string): Failure => ({ family, reason });

const TEXT_FIELDS = ["must_contain", "one_of", "must_not_contain", "must_not_match", "must_pass_on", "max_sentences"] as const;

function textCase(c: EvaluationCase): Case {
  const fields = Object.fromEntries(TEXT_FIELDS.filter((k) => k in c).map((k) => [k, c[k]]));
  return makeCase({ id: c.id, question: c.message, ...fields });
}

/** The list of failures; empty, the trial succeeds for the code. */
export function grade(c: EvaluationCase, trial: Trial): Failure[] {
  if (trial.error) return [failure("trace", `error: ${trial.error}`)];
  if (!trial.text.trim()) return [failure("trace", "empty answer")];
  const failures: Failure[] = [];

  const category = trial.category.split(",")[0]!; // “information, fallback”: went through information
  if (!c.category.includes(category)) {
    failures.push(failure("routing", `routed to ${trial.category}, expected ${c.category.join(" or ")}`));
  }

  const state = c.state ?? {};
  if (trial.orders) failures.push(failure("state", `${trial.orders} order(s) created without the customer's confirmation`));
  const pending = trial.summaries.filter((s) => s.status === "pending");
  if ("summary" in state && Boolean(pending.length) !== state.summary) {
    failures.push(failure("state", state.summary ? "summary expected, none prepared" : "summary prepared when it should not have been"));
  }
  if ("total" in state && pending.length && pending.at(-1)!.total !== state.total) {
    failures.push(failure("state", `total ${pending.at(-1)!.total} FCFA, expected ${state.total}`));
  }
  if ("passed_on" in state && Boolean(trial.requests.length) !== state.passed_on) {
    failures.push(failure("state", state.passed_on ? "no request passed on to Awa" : `request passed on to Awa for no reason (${trial.requests.join(", ")})`));
  }
  if (state.reason?.length && trial.requests.length && !trial.requests.some((r) => state.reason!.includes(r))) {
    failures.push(failure("state", `reason ${trial.requests.join(", ")}, expected ${state.reason.join(" or ")}`));
  }

  const textGrade = gradeText(textCase(c), trial.claude_text);
  failures.push(...textGrade.reasons.map((r) => failure("text", r)));
  if (announces(ANNOUNCED_PASS_ON, trial.claude_text) && !trial.requests.length) {
    failures.push(failure("text", "announces a pass-on to Awa that did not happen"));
  }
  if (announces(ANNOUNCED_ORDER, trial.claude_text) && !trial.orders) {
    failures.push(failure("text", "announces a recorded order that does not exist"));
  }
  return failures;
}
