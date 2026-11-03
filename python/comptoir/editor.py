"""Anthropic's text editor tool, run by your code in a closed folder (chapter 10).

Anthropic defines the tool (text_editor_20250728, named str_replace_based_edit_tool): its
schema, and the way Claude uses it. Your code runs it. So it has all the
responsibilities of access to files: staying in its folder, refusing an ambiguous
replacement, backing up before modifying.
"""

from pathlib import Path

TOOL = {"type": "text_editor_20250728", "name": "str_replace_based_edit_tool", "max_characters": 20000}


class EditorRefusal(Exception):
    pass


class Editor:
    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()

    def _path(self, path: str) -> Path:
        """A relative path, which stays in the root. No “..”, no absolute path."""
        candidate = (self.root / path).resolve()
        if Path(path).is_absolute() or not candidate.is_relative_to(self.root):
            raise EditorRefusal(f"Error: Path outside the allowed folder: {path}")
        return candidate

    def _back_up(self, file: Path) -> None:
        if file.exists():
            file.with_name(file.name + ".backup").write_text(file.read_text(encoding="utf-8"), encoding="utf-8")

    def execute(self, tool_input: dict) -> str:
        command = tool_input.get("command")
        file = self._path(tool_input["path"])
        if command == "view":
            if file.is_dir():
                return "\n".join(sorted(p.relative_to(self.root).as_posix() for p in file.iterdir()))
            if not file.exists():
                raise EditorRefusal("Error: File not found")
            lines = file.read_text(encoding="utf-8").splitlines()
            start, end = tool_input.get("view_range") or [1, -1]
            end = len(lines) if end == -1 else end
            # Line numbers, so that Claude can aim an insertion.
            return "\n".join(f"{n}: {lines[n - 1]}" for n in range(start, end + 1) if 0 < n <= len(lines))
        if command == "str_replace":
            if not file.exists():
                raise EditorRefusal("Error: File not found")
            content = file.read_text(encoding="utf-8")
            count = content.count(tool_input["old_str"])
            if count == 0:
                raise EditorRefusal("Error: No match found for replacement. Please check your text and try again.")
            if count > 1:
                raise EditorRefusal(f"Error: Found {count} matches for replacement text. "
                                    "Please provide more context to make a unique match.")
            self._back_up(file)
            file.write_text(content.replace(tool_input["old_str"], tool_input["new_str"]), encoding="utf-8")
            return "Successfully replaced text at exactly one location."
        if command == "create":
            if file.exists():
                raise EditorRefusal("Error: File already exists. Use str_replace to modify it.")
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(tool_input["file_text"], encoding="utf-8")
            return f"File created: {tool_input['path']}"
        if command == "insert":
            if not file.exists():
                raise EditorRefusal("Error: File not found")
            lines = file.read_text(encoding="utf-8").splitlines(keepends=True)
            position = tool_input["insert_line"]
            if not 0 <= position <= len(lines):
                raise EditorRefusal(f"Error: insert_line must be between 0 and {len(lines)}.")
            self._back_up(file)
            text = tool_input["insert_text"] if tool_input["insert_text"].endswith("\n") else tool_input["insert_text"] + "\n"
            file.write_text("".join(lines[:position] + [text] + lines[position:]), encoding="utf-8")
            return f"Text inserted after line {position}."
        raise EditorRefusal(f"Error: Unknown command {command!r}.")

    def result(self, tool_call) -> dict:
        """A tool_use block of the editor in, a tool_result out."""
        try:
            return {"type": "tool_result", "tool_use_id": tool_call.id, "content": self.execute(tool_call.input)}
        except (EditorRefusal, KeyError, UnicodeDecodeError) as error:
            return {"type": "tool_result", "tool_use_id": tool_call.id, "content": str(error), "is_error": True}
