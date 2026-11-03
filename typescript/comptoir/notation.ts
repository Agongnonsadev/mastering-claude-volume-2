// Grade an answer of the Comptoir with criteria written in advance (chapter 3).
//
// Each case says what the answer must contain, what it must not contain, and whether it must offer to
// pass the request on to Awa. What the code cannot judge is flagged for a human review. Chapter 17
// will go much further.

// Separators found between digits: a thousands comma, and the spaces of a French customer (normal,
// non-breaking, narrow non-breaking).
const SEPARATORS_BETWEEN_DIGITS = /(?<=\d),(?=\d{3}(?!\d))|(?<=\d)[   ](?=\d)/g;
const END_OF_SENTENCE = /[.!?…]+(?=\s|$)/g;
// “Hello!”, “Good evening, madam!”, “Bonjour !” at the top of an answer: a courtesy, not a sentence.
// Added in chapter 5: the example of prompt v1 itself starts with a greeting.
const GREETING = /^(hello|hi|good (morning|afternoon|evening)|bonjour|bonsoir)\b[^.!?…]{0,25}[.!]\s+/i;

/** Lowercase, straight apostrophes, “2,500” and “2500” written the same way. */
export function normalize(text: string): string {
  return text.normalize("NFC").toLowerCase().replaceAll("’", "'").replace(SEPARATORS_BETWEEN_DIGITS, "");
}

export function countSentences(text: string): number {
  const rest = text.trim().replace(GREETING, "").trim();
  return rest ? Math.max(1, rest.match(END_OF_SENTENCE)?.length ?? 0) : 0;
}

/**
 * An evaluation case. The field names are those of the case files (ch03/cases.json), shared with the
 * Python version.
 */
export interface Case {
  id: string;
  question: string;
  must_contain: string[]; //         all required
  one_of: string[]; //               at least one
  must_not_contain: string[];
  must_not_match: string[]; //       regular expressions
  must_pass_on: boolean;
  max_sentences: number;
  to_review: string; //              what a human must check, if the code cannot judge it
}

/** A case completed with its default values, from an object read in a case file. */
export function makeCase(d: Pick<Case, "id" | "question"> & Partial<Case>): Case {
  return {
    must_contain: [],
    one_of: [],
    must_not_contain: [],
    must_not_match: [],
    must_pass_on: false,
    max_sentences: 3,
    to_review: "",
    ...d,
  };
}

export interface Grade {
  passed: boolean;
  reasons: string[];
  toReview: string;
}

export const PASS_ON_WORDS = ["awa", "pass on", "passed on", "passing", "forward"];

export function grade(c: Case, answer: string): Grade {
  const text = normalize(answer);
  const reasons: string[] = [];

  for (const expected of c.must_contain) {
    if (!text.includes(normalize(expected))) reasons.push(`missing “${expected}”`);
  }
  if (c.one_of.length && !c.one_of.some((a) => text.includes(normalize(a)))) {
    reasons.push(`none of: ${c.one_of.join(", ")}`);
  }
  for (const forbidden of c.must_not_contain) {
    if (text.includes(normalize(forbidden))) reasons.push(`contains “${forbidden}”`);
  }
  for (const pattern of c.must_not_match) {
    if (new RegExp(pattern).test(text)) reasons.push(`matches ${pattern}`);
  }
  if (c.must_pass_on && !PASS_ON_WORDS.some((w) => text.includes(w))) {
    reasons.push("does not offer to pass it on to Awa");
  }
  if (countSentences(answer) > c.max_sentences) reasons.push(`more than ${c.max_sentences} sentences`);

  return { passed: reasons.length === 0, reasons, toReview: c.to_review };
}
