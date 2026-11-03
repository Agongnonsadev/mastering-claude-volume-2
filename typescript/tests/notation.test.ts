// The automatic grading of answers, on texts written for the test (python/tests/test_notation.py).

import assert from "node:assert/strict";
import { test } from "node:test";
import { countSentences, grade, makeCase, normalize } from "../comptoir/notation.ts";

test("separators in numbers do not count", () => {
  assert.equal(normalize("2,500 FCFA"), normalize("2500 FCFA"));
  assert.equal(normalize("2 500 FCFA"), normalize("2500 FCFA"));
  assert.equal(normalize("2 500 FCFA"), normalize("2500 FCFA"));
  assert.equal(normalize("2 500 FCFA"), normalize("2500 FCFA"));
});

test("count sentences", () => {
  assert.equal(countSentences("Yes. The syrup costs 2,500 FCFA! Anything else?"), 3);
  assert.equal(countSentences("A single sentence without a period"), 1);
  assert.equal(countSentences(""), 0);
});

test("a greeting at the top does not count", () => {
  assert.equal(countSentences("Hello! The juice is 1,000 FCFA. Anything else?"), 2);
  assert.equal(countSentences("Bonjour ! Oui, nous livrons aujourd'hui."), 1);
  assert.equal(countSentences("Good evening, madam! Yes."), 1);
  // Only at the top, and only a greeting: the rest always counts.
  assert.equal(countSentences("Thank you! Hello! Yes."), 3);
  assert.equal(countSentences("Congratulations on your wedding! Awa is preparing a quote."), 2);
  assert.equal(countSentences("Hello!"), 1);
});

test("right answer", () => {
  const c = makeCase({ id: "syrup-price", question: "How much is it?", must_contain: ["2,500"] });
  assert.ok(grade(c, "The syrup costs 2500 FCFA a bottle.").passed);
});

test("wrong price", () => {
  const c = makeCase({ id: "syrup-price", question: "How much is it?", must_contain: ["2,500"] });
  const result = grade(c, "The syrup costs 3,000 FCFA a bottle.");
  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("missing “2,500”"));
});

test("forbidden discount and required pass-on", () => {
  const c = makeCase({ id: "discount", question: "A price?", must_not_contain: ["%"], must_pass_on: true });
  assert.equal(grade(c, "I'll give you 10% off.").passed, false);
  assert.ok(grade(c, "I'm passing your request on to Awa, who will answer you.").passed);
});

test("invented number detected", () => {
  const c = makeCase({ id: "number", question: "Her number?", must_not_match: ["\\d{8,}"] });
  assert.equal(grade(c, "It's 01 97 00 00 00.").passed, false);
  assert.ok(grade(c, "I can't give out that number.").passed);
});

test("too long", () => {
  const c = makeCase({ id: "short", question: "?", max_sentences: 3 });
  assert.equal(grade(c, "One. Two. Three. Four.").passed, false);
});

test("a case to review is flagged", () => {
  const c = makeCase({ id: "baobab", question: "Any baobab?", to_review: "Do not claim to sell it." });
  assert.equal(grade(c, "We don't have any.").toReview, "Do not claim to sell it.");
});
