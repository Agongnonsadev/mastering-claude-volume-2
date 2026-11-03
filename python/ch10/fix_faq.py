"""Chapter 10: the text editor tool, run by our code in a closed folder.

Claude rereads the FAQ of Awa's website, compares it with the official terms, and fixes the
errors with the editor tool. The script works on a copy, in a temporary folder,
and displays the differences: nothing is modified in the repository.

Run, from the python/ folder:  python -m ch10.fix_faq
"""

import difflib
import shutil
import tempfile
from pathlib import Path

import anthropic

from comptoir import config
from comptoir.conversations import to_blocks
from comptoir.costs import cost
from comptoir.editor import TOOL, Editor
from comptoir.log import log_call
from comptoir.prompt import load_data, render_terms

FAQ_TEMPLATE = Path(__file__).parent / "data" / "faq-template.md"
MAX_TURNS = 8


def main() -> None:
    folder = Path(tempfile.mkdtemp(prefix="faq-"))
    shutil.copy(FAQ_TEMPLATE, folder / "faq.md")
    editor, client = Editor(folder), anthropic.Anthropic()
    instruction = (
        "The file faq.md is the FAQ of the Délices d'Awa website. Compare it with the official terms below "
        "and fix each statement that contradicts them, without changing anything else.\n\n<terms>\n"
        f"{render_terms(load_data())}\n</terms>"
    )
    messages = [{"role": "user", "content": instruction}]
    total = 0.0
    for _ in range(MAX_TURNS):
        message = client.messages.create(model=config.MODEL, max_tokens=4000, tools=[TOOL], messages=messages)
        price = cost(config.MODEL, message.usage)
        log_call(message._request_id, config.MODEL, price, stop_reason=message.stop_reason)
        total += price.dollars
        messages.append({"role": "assistant", "content": to_blocks(message.content)})
        calls = [b for b in message.content if b.type == "tool_use"]
        for tool_call in calls:
            print(f"  tool: {tool_call.input.get('command')} {tool_call.input.get('path')}")
        if message.stop_reason != "tool_use":
            break
        messages.append({"role": "user", "content": [editor.result(tool_call) for tool_call in calls]})

    print("\n" + "".join(b.text for b in message.content if b.type == "text"))
    before = FAQ_TEMPLATE.read_text(encoding="utf-8").splitlines(keepends=True)
    after = (folder / "faq.md").read_text(encoding="utf-8").splitlines(keepends=True)
    print("".join(difflib.unified_diff(before, after, "faq.md (before)", "faq.md (after)")))
    print(f"Cost: ${total:.4f}")
    shutil.rmtree(folder)


if __name__ == "__main__":
    main()
