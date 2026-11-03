// The Comptoir's guards (chapter 18): what the code checks itself, whatever the model writes.
//
// - What an answer announces, against what was done: the document assistant has no tool; if it writes
//   “I'm passing your request on to Awa”, it is a promise nobody will keep.
// - The fields written by the customer and kept by the shop, the name and the neighborhood: they end up in
//   Awa's Claude application, through the MCP server of chapter 15. Free text there would become an
//   indirect injection. These are short data; the code refuses everything else, before recording.
//
// The patterns are those of the Python version (python/comptoir/guard.py), in English and in French: the
// Comptoir answers in French a customer who writes in French. JavaScript's \b knows only unaccented
// letters: word boundaries are written here with the Unicode classes, as in Python.

export const BEFORE = "(?<![\\p{L}\\p{N}_])"; // a word boundary, in front (Python's \b)
export const AFTER = "(?![\\p{L}\\p{N}_])"; //    and behind
const words = (alternatives: string): string => `${BEFORE}(?:${alternatives})${AFTER}`;

// “I'm passing”, “I've passed”, “has been passed on”: a pass-on announced as done. “I can pass it on”,
// “would you like me to pass it on” are offers: ignored. The French forms follow.
export const ANNOUNCED_PASS_ON = new RegExp(
  [
    words("i(?:['’]ve| have) (?:passed|forwarded|sent)"),
    words("i(?:['’]m| am) (?:passing|forwarding)"),
    words("(?:has been|have been) (?:passed|forwarded)"),
    words("je (?:la |le |lui |les |vous )?transmets"),
    words("j'ai (?:bien )?transmis"),
    words("je viens de (?:la |le |lui )?transmettre"),
    words("(?:est|a été|a bien été|sont|ont été) transmise?s?"),
  ].join("|"),
  "iu",
);
const SENTENCE = /[^.!?…]+[.!?…]*/gu;
const CONDITION = new RegExp(words("if|when|once|as soon as|si|s'il|quand|lorsque|dès que|une fois que"), "giu");
// What closes a condition: “if the quote provides for it, so I'm passing it on” is an announcement.
const END_OF_CONDITION = new RegExp(`${words("so|then|therefore|donc|alors")}|[:;]`, "iu");

/**
 * True if a condition governs what follows: an “if” without “so”, “then”, colon or semicolon between it
 * and the rest. “If you wish, I'm passing it on to her” stays an offer.
 */
export function underCondition(before: string): boolean {
  const conditions = [...before.matchAll(CONDITION)];
  const last = conditions.at(-1);
  return last !== undefined && !END_OF_CONDITION.test(before.slice(last.index + last[0].length));
}

/** True if a sentence states a pass-on, without a condition governing it and without being a question. */
export function announcesPassOn(text: string): boolean {
  for (const sentence of text.replaceAll("’", "'").match(SENTENCE) ?? []) {
    const found = ANNOUNCED_PASS_ON.exec(sentence);
    if (found && !underCondition(sentence.slice(0, found.index)) && !sentence.trimEnd().endsWith("?")) return true;
  }
  return false;
}

// --- The customer's fields ----------------------------------------------------------------------

export const MAX_NAME_LENGTH = 60;
export const MAX_NEIGHBORHOOD_LENGTH = 40;
// Letters (accents included), separated by a space, a hyphen, an apostrophe or a period:
// “Larissa Noudéhou”, “Mrs. Akpovi”, “Jean-Marc”, “N'Dah”. No digit, no colon, no bracket.
const NAME = /^\p{L}+(?:[ '’.-]+\p{L}+)*\.?$/u;
// A neighborhood can carry a number (“Zone 4”, “PK 10”): letters and digits, same separators.
const NEIGHBORHOOD = /^[\p{L}\p{N}]+(?:[ '’.-]+[\p{L}\p{N}]+)*$/u;
const MAX_WORDS = 6;

function problem(value: string, pattern: RegExp, maxLength: number, what: string): string | null {
  const v = value.trim();
  if (!v) return `${what} is empty`;
  const length = [...v].length; // in characters, like len() in Python
  if (length > maxLength || v.split(/\s+/).length > MAX_WORDS) return `${what} is too long (${length} characters)`;
  if (!pattern.test(v)) return `${what} contains something other than letters${pattern === NEIGHBORHOOD ? " and digits" : ""}`;
  return null;
}

/** null if the name is acceptable; otherwise, what is wrong, to tell Claude. */
export function nameProblem(name: string): string | null {
  return problem(name, NAME, MAX_NAME_LENGTH, "the name");
}

export function neighborhoodProblem(neighborhood: string): string | null {
  return problem(neighborhood, NEIGHBORHOOD, MAX_NEIGHBORHOOD_LENGTH, "the neighborhood");
}
