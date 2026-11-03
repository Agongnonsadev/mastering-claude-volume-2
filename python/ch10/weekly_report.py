"""Chapter 10: Awa's weekly sales report, calculated and laid out by code execution.

1. The CSV export goes to the container, through the Files API.
2. Claude writes and runs the code: totals, PNG chart, PDF report, JSON summary.
3. The script downloads the files, then compares the summary with our own calculation.
4. It deletes from the Files API the file sent and the files produced.

Run, from the python/ folder:  python -m ch10.weekly_report
"""

import json
from pathlib import Path

import anthropic

from comptoir import config
from comptoir.sales import compare, read, totals
from comptoir.server_tools import CODE_EXECUTION, call, produced_files, tool_errors

SALES = Path(__file__).parent / "data" / "sales-2026-10-12.csv"
OUTPUT = Path("reports") / "week-2026-10-12"

INSTRUCTION = """Here is the export of the sales of Délices d'Awa for the week of October 12 to 18, 2026, a CSV file.
With code, and only with code (no figures from your head):
1. calculate the total revenue in FCFA (quantity × unit_price_fcfa), the number of distinct orders, the average basket rounded to the unit,
   and the revenue per product (quantity and amount), per day and per neighborhood;
2. plot the revenue per product as horizontal bars, readable on a phone, in chart.png;
3. produce report.pdf, one page in English: title, key figures, table per product, the chart;
4. write summary.json with exactly these keys: revenue_fcfa, orders, average_basket_fcfa,
   by_product (product -> {"quantity", "amount_fcfa"}), by_day (ISO date -> amount), by_neighborhood (neighborhood -> amount).
Copy chart.png, report.pdf and summary.json into $OUTPUT_DIR, then list that folder in the same command.
End with three sentences for Awa about the week."""


def main() -> None:
    client = anthropic.Anthropic()
    with SALES.open("rb") as f:
        sent = client.files.upload(file=(SALES.name, f, "text/csv"))
    produced: list[str] = []
    try:
        request = {
            "model": config.MODEL,
            "max_tokens": 16000,
            "tools": [CODE_EXECUTION],
            "messages": [{"role": "user", "content": [{"type": "container_upload", "file_id": sent.id},
                                                      {"type": "text", "text": INSTRUCTION}]}],
        }
        result = call(client, request)
        print(result.text)
        for error in tool_errors(result.message):
            print(f"  ⚠ {error}")

        OUTPUT.mkdir(parents=True, exist_ok=True)
        for message in result.messages:
            produced += produced_files(message)
        for file_id in produced:
            name = client.files.retrieve_metadata(file_id).filename
            client.files.download(file_id).write_to_file(OUTPUT / name)
            print(f"  file received: {OUTPUT / name}")

        summary = OUTPUT / "summary.json"
        if summary.exists():
            gaps = compare(json.loads(summary.read_text(encoding="utf-8")), totals(read(SALES)))
            print("\nCheck by our code: " + ("all the figures match." if not gaps else "GAPS"))
            for gap in gaps:
                print(f"  - {gap}")
        else:
            print("\nNo summary.json: the report cannot be checked, so it is not sent.")

        usage = result.message.usage
        print(f"\n{result.calls} call(s), {result.resumptions} resumption(s); last call: input {usage.input_tokens} "
              f"tokens, output {usage.output_tokens}; cost in tokens ${result.cost:.4f}; "
              f"container {result.message.container.id if result.message.container else '?'}")
    finally:
        # A file sent or produced stays stored as long as it is not deleted.
        for file_id in [sent.id, *produced]:
            client.files.delete(file_id)
        print("Files deleted from the Files API.")


if __name__ == "__main__":
    main()
