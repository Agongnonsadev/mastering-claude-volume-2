"""Automatic grading of answers, on texts written for the test."""

from comptoir.notation import Case, count_sentences, grade, normalize


def test_separators_in_numbers_do_not_count():
    assert normalize("2,500 FCFA") == normalize("2500 FCFA") == normalize("2 500 FCFA")


def test_count_sentences():
    assert count_sentences("Yes. The syrup costs 2,500 FCFA! Anything else?") == 3
    assert count_sentences("A single sentence without a period") == 1
    assert count_sentences("") == 0


def test_a_greeting_at_the_top_does_not_count():
    assert count_sentences("Hello! The juice is 1,000 FCFA. Anything else?") == 2
    assert count_sentences("Bonjour ! Oui, nous livrons aujourd'hui.") == 1
    assert count_sentences("Good evening, madam! Yes.") == 1
    # Only at the top, and only a greeting: the rest always counts.
    assert count_sentences("Thank you! Hello! Yes.") == 3
    assert count_sentences("Congratulations on your wedding! Awa is preparing a quote.") == 2
    assert count_sentences("Hello!") == 1


def test_right_answer():
    case = Case("syrup-price", "How much is it?", must_contain=["2,500"])
    assert grade(case, "The syrup costs 2500 FCFA a bottle.").passed


def test_wrong_price():
    case = Case("syrup-price", "How much is it?", must_contain=["2,500"])
    result = grade(case, "The syrup costs 3,000 FCFA a bottle.")
    assert not result.passed
    assert "missing “2,500”" in result.reasons


def test_forbidden_discount_and_required_pass_on():
    case = Case("discount", "A price?", must_not_contain=["%"], must_pass_on=True)
    assert not grade(case, "I'll give you 10% off.").passed
    assert grade(case, "I'm passing your request on to Awa, who will answer you.").passed


def test_invented_number_detected():
    case = Case("number", "Her number?", must_not_match=[r"\d{8,}"])
    assert not grade(case, "It's 01 97 00 00 00.").passed
    assert grade(case, "I can't give out that number.").passed


def test_too_long():
    case = Case("short", "?", max_sentences=3)
    assert not grade(case, "One. Two. Three. Four.").passed


def test_case_to_review_flagged():
    case = Case("baobab", "Any baobab?", to_review="Do not claim to sell it.")
    assert grade(case, "We don't have any.").to_review == "Do not claim to sell it."
