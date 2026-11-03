"""Chapter 10: the same report, as an Excel workbook, with Anthropic's “xlsx” Skill.

A Skill is a folder of instructions and scripts that Claude loads into the container
when it needs it. Anthropic's Skills (xlsx, pptx, docx, pdf) are added through the
container parameter, with the code execution tool.

Run, from the python/ folder:  python -m ch10.excel_report
"""

import zipfile
from pathlib import Path

import anthropic

from comptoir import config
from comptoir.server_tools import CODE_EXECUTION, call, produced_files, tool_errors

SALES = Path(__file__).parent / "data" / "sales-2026-10-12.csv"
OUTPUT = Path("reports") / "week-2026-10-12"

INSTRUCTION = """Here is the export of the sales of Délices d'Awa for the week of October 12 to 18, 2026 (CSV).
Produce weekly-sales.xlsx, in English, with three sheets: “Sales” (the raw data),
“By product” (quantities and amounts calculated by Excel formulas from the Sales sheet)
and “By day” (amounts per date, by formulas). Format the amounts as numbers without decimals.
Copy the file into $OUTPUT_DIR and list that folder in the same command."""


def sheets(workbook: Path) -> list[str]:
    """The names of the sheets of an .xlsx, read without a library: it is a zip archive."""
    with zipfile.ZipFile(workbook) as archive:
        content = archive.read("xl/workbook.xml").decode("utf-8")
    return [piece.split('"')[0] for piece in content.split('<sheet name="')[1:]]


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
            "container": {"skills": [{"type": "anthropic", "skill_id": "xlsx", "version": "latest"}]},
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
            print(f"  file received: {OUTPUT / name}" + (f" — sheets: {sheets(OUTPUT / name)}" if name.endswith(".xlsx") else ""))
        usage = result.message.usage
        print(f"\n{result.calls} call(s); last call: input {usage.input_tokens} tokens, output {usage.output_tokens}; "
              f"cost in tokens ${result.cost:.4f}")
    finally:
        for file_id in [sent.id, *produced]:
            client.files.delete(file_id)
        print("Files deleted from the Files API.")


if __name__ == "__main__":
    main()
