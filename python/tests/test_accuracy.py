"""Measure accuracy: each field correct, missed, invented or wrong."""

from comptoir.accuracy import Gap, compare, summarize

EXPECTED = {
    "customer": "Mrs. Dossou",
    "neighborhood": "Cadjèhoun",
    "total_read": None,
    "lines": [
        {"product": "Soursop juice", "quantity": None, "unit_price_read": 1000},
        {"product": "Ginger juice", "quantity": 3, "unit_price_read": 1000},
    ],
}


def test_the_four_outcomes():
    assert Gap("d", "f", "Cadjèhoun", "cadjehoun").outcome == "correct"  # case and accents ignored
    assert Gap("d", "f", 3, None).outcome == "missed"
    assert Gap("d", "f", None, 12).outcome == "invented"
    assert Gap("d", "f", 3, 8).outcome == "wrong"
    assert Gap("d", "f", None, None).outcome == "correct"  # “illegible” expected, “illegible” returned


def test_a_stained_quantity_guessed_is_an_invented_value():
    obtained = {**EXPECTED, "lines": [{**EXPECTED["lines"][0], "quantity": 12}, EXPECTED["lines"][1]]}
    outcomes = {g.field: g.outcome for g in compare("order-03.jpg", EXPECTED, obtained)}
    assert outcomes["lines.0.quantity"] == "invented"
    assert sum(1 for o in outcomes.values() if o == "correct") == len(outcomes) - 1


def test_a_failed_extraction_misses_everything():
    summary = summarize(compare("order-03.jpg", EXPECTED, None))
    # The fields expected as null are “correct”: a failure does not invent them.
    assert summary["missed"] == 7 and summary["invented"] == 0


def test_a_line_read_in_excess_is_invented():
    obtained = {**EXPECTED, "lines": EXPECTED["lines"] + [{"product": "Bissap juice", "quantity": 2}]}
    assert compare("order-03.jpg", EXPECTED, obtained)[-1].outcome == "invented"
