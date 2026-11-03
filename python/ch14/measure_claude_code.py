"""Chapter 14: three questions from Yao to Claude Code, on the copy of the orders, through MCP.

Run, from the python/ folder (PAID CALL: Claude Code uses your API key):
    python -m ch14.measure_claude_code --claude "path/to/claude" --max-budget 0.40

Each question is asked in a fresh `claude -p` session, which loads the MCP server of the
.mcp.json file (project scope). Only the two tools of the orders server are allowed;
any other tool is refused (--permission-mode dontAsk). Each answer is compared with the right
answers calculated by the code (ch14/truths.py), and the cost is read in the JSON output.
"""

import argparse
import json
import re
import subprocess
from datetime import datetime, timezone

from ch14.servers import ROOT
from ch14.truths import compute

TOOLS = "mcp__orders__execute_sql,mcp__orders__search_objects"
RESULTS = ROOT / "ch14" / "results"
MODEL = "claude-sonnet-5-5"  # the Comptoir's model (chapter 3)

QUESTIONS = [
    ("schema", "Describe the orders database plugged in through MCP: which tables, and how is an order "
               "linked to its products and to the customer's neighborhood? Answer in five lines at most."),
    ("neighborhoods", "From Monday, September 21 to Sunday, October 18, 2026, which three neighborhoods brought "
                      "in the most, in FCFA, and how many orders for each? Give the exact amounts."),
    ("abandonments", "How many conversations received at least one summary without any of them becoming an "
                     "order, out of how many conversations in total? At what hour of the day is the abandonment "
                     "rate highest (among the hours with at least 20 summaries)?"),
]


def digits(text: str) -> str:
    """“194,500” or “194 500” or “194.500”: the figures are compared without their separators."""
    return re.sub(r"(?<=\d)[\s  .,](?=\d{3}\b)", "", text)


def hour_pattern(hour: int) -> str:
    """11 -> “11:00”, “11h”, “11 a.m.”, “11am”; 18 -> “18:00”, “18h”, “6 p.m.”, “6pm”."""
    twelve, suffix = hour % 12 or 12, (r"a\.?m\b\.?" if hour < 12 else r"p\.?m\b\.?")
    return rf"\b{hour}:00|\b{hour}\s*h\b|\b{twelve}\s*{suffix}" + (r"|\bnoon\b" if hour == 12 else "")


def check(question: str, answer: str, truths: dict) -> list[str]:
    """The gaps between the answer and what the code calculated. Empty list: right answer."""
    text = digits(answer)
    gaps = []
    if question == "schema":
        for word in ("summaries", "orders", "lines", "neighborhood"):
            if word not in text.lower():
                gaps.append(f"does not mention “{word}”")
        if "json" not in text.lower():
            gaps.append("does not say that the lines are JSON")
    elif question == "neighborhoods":
        for n in truths["neighborhoods"]:
            if n["neighborhood"] not in answer:
                gaps.append(f"missing neighborhood: {n['neighborhood']}")
            if str(n["fcfa"]) not in text:
                gaps.append(f"missing amount for {n['neighborhood']}: {n['fcfa']}")
            if not re.search(rf"\b{n['orders']}\b", text):
                gaps.append(f"missing number of orders for {n['neighborhood']}: {n['orders']}")
    elif question == "abandonments":
        for key in ("abandonments", "conversations"):
            if not re.search(rf"\b{truths[key]}\b", text):
                gaps.append(f"{key}: {truths[key]} expected")
        hour = truths["worst_abandonment_hour"]
        if not re.search(hour_pattern(hour), text, re.IGNORECASE):
            gaps.append(f"expected hour: {hour}:00")
    return gaps


def ask(claude: str, question: str, budget: float) -> dict:
    command = [claude, "-p", question, "--model", MODEL, "--output-format", "json",
               "--allowedTools", TOOLS, "--permission-mode", "dontAsk",
               "--max-budget-usd", f"{budget:.2f}", "--no-session-persistence"]
    output = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=600)
    if output.returncode != 0 and not output.stdout.strip():
        raise RuntimeError(f"claude -p failed: {output.stderr[-800:]}")
    return json.loads(output.stdout)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--claude", default="claude", help="the claude program (Claude Code)")
    parser.add_argument("--max-budget", type=float, default=0.40, help="ceiling per question, in dollars")
    parser.add_argument("--only", choices=[q for q, _ in QUESTIONS])
    args = parser.parse_args()
    truths = compute()
    RESULTS.mkdir(parents=True, exist_ok=True)
    total = 0.0
    for name, question in QUESTIONS:
        if args.only and name != args.only:
            continue
        result = ask(args.claude, question, args.max_budget)
        answer = result.get("result", "")
        gaps = check(name, answer, truths)
        cost = result.get("total_cost_usd", 0.0)
        total += cost
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        (RESULTS / f"{timestamp}-{name}.json").write_text(
            json.dumps({"question": question, "gaps": gaps, "output": result}, ensure_ascii=False, indent=2),
            encoding="utf-8")
        print(f"\n=== {name}: {'right' if not gaps else 'GAPS: ' + '; '.join(gaps)}")
        print(f"{result.get('num_turns')} turns, ${cost:.4f}, stop: {result.get('subtype')}")
        print(answer.strip()[:1500])
    print(f"\nTotal cost: ${total:.4f}")


if __name__ == "__main__":
    main()
