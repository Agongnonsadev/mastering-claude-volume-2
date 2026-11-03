"""The text editor tool, run by our code: a closed folder, replacements without ambiguity."""

from types import SimpleNamespace

import pytest

from comptoir.editor import TOOL, Editor, EditorRefusal


@pytest.fixture
def editor(tmp_path):
    (tmp_path / "faq.md").write_text("Free delivery from 3 bottles.\nPayment: Mobile Money.\n", encoding="utf-8")
    return Editor(tmp_path)


def test_anthropics_tool():
    assert TOOL["type"] == "text_editor_20250728" and TOOL["name"] == "str_replace_based_edit_tool"


@pytest.mark.parametrize("path", ["../secret.txt", "/etc/passwd", "sub/../../escape.md"])
def test_no_way_out_of_the_folder(editor, path):
    with pytest.raises(EditorRefusal, match="outside"):
        editor.execute({"command": "view", "path": path})


def test_view_with_line_numbers(editor):
    assert editor.execute({"command": "view", "path": "faq.md"}).splitlines()[1] == "2: Payment: Mobile Money."
    assert editor.execute({"command": "view", "path": "."}) == "faq.md"


def test_replace_a_single_occurrence_and_keep_a_backup(editor, tmp_path):
    editor.execute({"command": "str_replace", "path": "faq.md", "old_str": "from 3 bottles", "new_str": "from 5 bottles"})
    assert "from 5 bottles" in (tmp_path / "faq.md").read_text(encoding="utf-8")
    assert "from 3 bottles" in (tmp_path / "faq.md.backup").read_text(encoding="utf-8")


def test_an_ambiguous_or_missing_replacement_is_refused(editor):
    with pytest.raises(EditorRefusal, match="Found 2 matches"):
        editor.execute({"command": "str_replace", "path": "faq.md", "old_str": "Mo", "new_str": "MO"})
    with pytest.raises(EditorRefusal, match="No match"):
        editor.execute({"command": "str_replace", "path": "faq.md", "old_str": "Porto-Novo", "new_str": "x"})


def test_create_without_overwriting_and_insert(editor, tmp_path):
    with pytest.raises(EditorRefusal, match="already exists"):
        editor.execute({"command": "create", "path": "faq.md", "file_text": "x"})
    editor.execute({"command": "insert", "path": "faq.md", "insert_line": 0, "insert_text": "# FAQ"})
    assert (tmp_path / "faq.md").read_text(encoding="utf-8").startswith("# FAQ\nFree delivery")


def test_an_error_becomes_a_result_in_error(editor):
    tool_call = SimpleNamespace(id="t1", input={"command": "view", "path": "missing.md"})
    result = editor.result(tool_call)
    assert result["is_error"] and "File not found" in result["content"]
