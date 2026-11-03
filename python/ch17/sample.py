"""Chapter 17: draw the answers a human will grade, then calibrate the judge on their grades.

From the python/ folder (free: no call):
    python -m ch17.sample draw <series> --size 30
    python -m ch17.sample page [--complement results/sample-haiku.json]   (results/to_grade.html)
    python -m ch17.sample calibrate <series> --model claude-haiku-5-5 [--half calibration]

The page keeps the grades in the browser; a button downloads them as human_grades.json,
to put in results/.

The sample takes a single trial per case, to see as many cases as possible, and respects the
share of each type (common, trap, security). It is cut into two halves: the judge's rubric is
corrected by looking at the “calibration” half, and the corrected rubric is checked on the
“control” half, which was not looked at. Otherwise, the rubric gets fitted to those very answers.

The human grades blind, without seeing the judge's verdicts, with the same information as the judge:
the message, the answer, the summary, what the system did, the reference, and the documents.
Their grades go into results/human_grades.json: {trial: {criterion: verdict}}.
"""

import argparse
import json
import random
from pathlib import Path

from ch17 import calibration
from ch17.judge import CRITERIA, RUBRIC, actions, documents
from ch17.suite import load_cases, read_judgments, read_series

FOLDER = Path(__file__).parent / "results"
SAMPLE = FOLDER / "sample.json"
GRADES = FOLDER / "human_grades.json"
PAGE = Path(__file__).parent / "grading_page.html"
TYPES = ("common", "trap", "security")


def draw(trials, cases: list[dict], size: int, seed: int = 17) -> dict:
    rng = random.Random(seed)
    by_id = {c["id"]: c for c in cases}
    by_case: dict[str, list] = {}
    for t in trials:
        by_case.setdefault(t.case, []).append(t)
    kept = []
    for kind in TYPES:
        candidates = sorted(c for c in by_case if by_id[c]["type"] == kind)
        share = round(size * len(candidates) / len(by_case))
        kept += [rng.choice(by_case[c]) for c in rng.sample(candidates, min(share, len(candidates)))]
    rng.shuffle(kept)
    half = len(kept) // 2
    cards = [{
        "trial": t.identifier,
        "case": t.case,
        "type": by_id[t.case]["type"],
        "message": by_id[t.case]["message"],
        "answer": t.claude_text,
        "summary": t.text[len(t.claude_text):].strip(),
        "actions": actions(t),
        "reference": by_id[t.case]["reference"],
    } for t in kept]
    return {"trials": [t.identifier for t in kept],
            "halves": {"calibration": [t.identifier for t in kept[:half]],
                       "control": [t.identifier for t in kept[half:]]},
            "criteria": list(CRITERIA),
            "cards": cards}


def cmd_draw(args) -> None:
    sample = draw(read_series(Path(args.series)), load_cases(), args.size)
    sample["series"] = Path(args.series).name
    output = Path(args.output) if args.output else SAMPLE
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(sample, ensure_ascii=False, indent=1), encoding="utf-8")
    types = [c["type"] for c in sample["cards"]]
    print(f"{len(types)} answers: " + ", ".join(f"{t} {types.count(t)}" for t in TYPES) + f" → {output}")


def page_content(sample: dict) -> str:
    """The grading page, filled in: the cards in the order of the draw, without any verdict from the judge."""
    data = {"criteria": sample["criteria"], "cards": sample["cards"],
            "documents": documents().replace("<documents>", "").replace("</documents>", "").strip()}
    # “</” would close the <script> tag that carries the data.
    return PAGE.read_text(encoding="utf-8").replace("__DATA__", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))


def complement(cards: list[dict], number: int, seed: int = 1717) -> list[dict]:
    """A few answers from another variant, on the same cases, so that a human judges it too.
    Same share of each type as the sample; nothing on the card says which model answered."""
    rng = random.Random(seed)
    by_type: dict[str, list[dict]] = {}
    for c in cards:
        by_type.setdefault(c["type"], []).append(c)
    kept = []
    for kind in TYPES:
        share = round(number * len(by_type.get(kind, [])) / len(cards))
        kept += rng.sample(sorted(by_type.get(kind, []), key=lambda c: c["trial"]), share)
    rng.shuffle(kept)
    return kept


def cmd_page(args) -> None:
    sample = json.loads(SAMPLE.read_text(encoding="utf-8"))
    if args.complement:
        added = complement(json.loads(Path(args.complement).read_text(encoding="utf-8"))["cards"], args.number)
        sample["complement"] = [c["trial"] for c in added]
        SAMPLE.write_text(json.dumps(sample, ensure_ascii=False, indent=1), encoding="utf-8")
        sample = {**sample, "cards": sample["cards"] + added}
    content = page_content(sample)
    output = FOLDER / "to_grade.html"
    output.write_text('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
                      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head>'
                      f"<body>\n{content}\n</body></html>\n", encoding="utf-8")
    if args.no_skeleton:
        Path(args.no_skeleton).write_text(content, encoding="utf-8")
    print(f"Grading page: {output}")


def cmd_calibrate(args) -> None:
    sample = json.loads(SAMPLE.read_text(encoding="utf-8"))
    human = json.loads(GRADES.read_text(encoding="utf-8"))
    if args.half == "complement":
        kept = set(sample.get("complement", []))  # the other variant's answers: pass its series
    else:
        kept = set(sample["halves"][args.half] if args.half != "all" else sample["trials"])
    human = {t: {c: v for c, v in g.items() if c in CRITERIA} for t, g in human.items() if t in kept}
    judgments = read_judgments(Path(args.series), args.model, args.rubric)
    judge = {t: j["verdicts"] for t, j in judgments.items() if t in kept and j.get("verdicts")}
    results = calibration.compare(human, judge)
    print(f"Judge {args.model} (rubric {args.rubric}), half “{args.half}”: "
          f"{len(set(human) & set(judge))} answers graded on both sides\n")
    print(calibration.show(results))
    agreements, total, disagreements = calibration.overall_agreement(human, judge)
    print(f"\nSame outcome (passed, failed, to review): {agreements} out of {total}")
    cards = {c["trial"]: c for c in sample["cards"]}
    if args.half == "complement":
        other = Path(args.series).name.split("-", 2)[2].rsplit("-", 1)[0]  # “haiku” in 2026…-haiku-improvement
        path = FOLDER / f"sample-{other}.json"
        if path.exists():
            cards |= {c["trial"]: c for c in json.loads(path.read_text(encoding="utf-8"))["cards"]}
    for a in results:
        for trial in a.false_yes + a.false_no + a.others:
            print(f"\n[{a.criterion}] {trial}: human {human[trial][a.criterion]}, judge {judge[trial][a.criterion]}")
            print(f"  message: {cards[trial]['message']}\n  answer: {cards[trial]['answer']}")
            print(f"  the judge's finding: {judgments[trial]['findings'][a.criterion]}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("draw")
    p.add_argument("series")
    p.add_argument("--size", type=int, default=30)
    p.add_argument("--output", help="a file other than results/sample.json (same draw: same cases, same trials)")
    p = commands.add_parser("page")
    p.add_argument("--no-skeleton", help="also write the page without <html> or <head>, to publish it")
    p.add_argument("--complement", help="a sample of another variant (same draw), from which to add a few answers")
    p.add_argument("--number", type=int, default=10)
    p = commands.add_parser("calibrate")
    p.add_argument("series")
    p.add_argument("--model", default="claude-haiku-5-5")
    p.add_argument("--rubric", default=RUBRIC)
    p.add_argument("--half", default="calibration", choices=["calibration", "control", "all", "complement"])
    args = parser.parse_args()
    {"draw": cmd_draw, "page": cmd_page, "calibrate": cmd_calibrate}[args.command](args)


if __name__ == "__main__":
    main()
