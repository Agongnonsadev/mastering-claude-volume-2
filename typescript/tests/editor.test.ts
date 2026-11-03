// The text editor tool, run by our code: a closed folder, replacements without ambiguity
// (python/tests/test_editor.py), and the same answers as the Python version.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { beforeEach, test } from "node:test";
import { Editor, EditorRefusal, type Input, TOOL } from "../comptoir/editor.ts";
import { PYTHON } from "../comptoir/launch.ts";

let folder: string;
let editor: Editor;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "editor-"));
  writeFileSync(join(folder, "faq.md"), "Free delivery from 3 bottles.\nPayment: Mobile Money.\n", "utf8");
  editor = new Editor(folder);
});

const read = (name: string): string => readFileSync(join(folder, name), "utf8");

test("Anthropic's tool", () => {
  assert.ok(TOOL.type === "text_editor_20250728" && TOOL.name === "str_replace_based_edit_tool");
});

for (const path of ["../secret.txt", "/etc/passwd", "sub/../../escape.md"]) {
  test(`no way out of the folder: ${path}`, () => {
    assert.throws(() => editor.execute({ command: "view", path }), (e) => e instanceof EditorRefusal && /outside/.test(e.message));
  });
}

test("a link to another folder does not get out either", () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
  writeFileSync(join(elsewhere, "secret.txt"), "not to be read", "utf8");
  symlinkSync(elsewhere, join(folder, "link"), "junction"); // a junction: no administrator rights needed on Windows
  assert.throws(() => editor.execute({ command: "view", path: "link/secret.txt" }), /outside/);
  assert.throws(() => editor.execute({ command: "create", path: "link/new.md", file_text: "x" }), /outside/);
});

test("view with line numbers", () => {
  assert.equal(editor.execute({ command: "view", path: "faq.md" }).split("\n")[1], "2: Payment: Mobile Money.");
  assert.equal(editor.execute({ command: "view", path: "faq.md", view_range: [2, -1] }), "2: Payment: Mobile Money.");
  assert.equal(editor.execute({ command: "view", path: "." }), "faq.md");
});

test("replace a single occurrence and keep a backup", () => {
  editor.execute({ command: "str_replace", path: "faq.md", old_str: "from 3 bottles", new_str: "from 5 bottles" });
  assert.ok(read("faq.md").includes("from 5 bottles"));
  assert.ok(read("faq.md.backup").includes("from 3 bottles"));
});

test("the replacement text is taken as is, “$&” included", () => {
  editor.execute({ command: "str_replace", path: "faq.md", old_str: "Mobile Money", new_str: "Mobile Money ($& and $1)" });
  assert.ok(read("faq.md").includes("Mobile Money ($& and $1)"));
});

test("an ambiguous or missing replacement is refused", () => {
  assert.throws(() => editor.execute({ command: "str_replace", path: "faq.md", old_str: "Mo", new_str: "MO" }), /Found 2 matches/);
  assert.throws(() => editor.execute({ command: "str_replace", path: "faq.md", old_str: "Porto-Novo", new_str: "x" }), /No match/);
  assert.ok(!existsSync(join(folder, "faq.md.backup"))); // nothing was modified
});

test("create without overwriting, and insert", () => {
  assert.throws(() => editor.execute({ command: "create", path: "faq.md", file_text: "x" }), /already exists/);
  editor.execute({ command: "insert", path: "faq.md", insert_line: 0, insert_text: "# FAQ" });
  assert.ok(read("faq.md").startsWith("# FAQ\nFree delivery"));
  assert.throws(() => editor.execute({ command: "insert", path: "faq.md", insert_line: 9, insert_text: "x" }), /between 0 and 3/);
  assert.equal(editor.execute({ command: "create", path: "sub/new.md", file_text: "Hello" }), "File created: sub/new.md");
  assert.equal(read("sub/new.md"), "Hello");
});

test("a file with Windows line endings is read and modified like the others", () => {
  writeFileSync(join(folder, "windows.md"), "Line one\r\nLine two\r\n", "utf8");
  assert.equal(editor.execute({ command: "view", path: "windows.md" }), "1: Line one\n2: Line two");
  editor.execute({ command: "str_replace", path: "windows.md", old_str: "one\nLine", new_str: "1\nLine" });
  assert.equal(read("windows.md"), "Line 1\nLine two\n");
});

test("an error becomes a result in error", () => {
  const result = editor.result({ id: "t1", input: { command: "view", path: "missing.md" } });
  assert.ok(result.is_error && String(result.content).includes("File not found"));
  // A missing field: the same message as a KeyError in Python.
  assert.deepEqual(editor.result({ id: "t2", input: { command: "str_replace", path: "faq.md" } }), {
    type: "tool_result",
    tool_use_id: "t2",
    content: "'old_str'",
    is_error: true,
  });
});

// --- The same answers as the Python version ----------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);

const SEQUENCE: Input[] = [
  { command: "view", path: "." },
  { command: "view", path: "faq.md", view_range: [1, 2] },
  { command: "view", path: "windows.md" },
  { command: "str_replace", path: "faq.md", old_str: "Mo", new_str: "MO" },
  { command: "str_replace", path: "faq.md", old_str: "", new_str: "x" },
  { command: "str_replace", path: "faq.md", old_str: "from 3", new_str: "from 5" },
  { command: "str_replace", path: "windows.md", old_str: "one\nLine", new_str: "1\nLine" },
  { command: "str_replace", path: "faq.md" },
  { command: "insert", path: "faq.md", insert_line: 1, insert_text: "Opening hours: 8 a.m. – 6 p.m." },
  { command: "insert", path: "faq.md", insert_line: 7, insert_text: "x" },
  { command: "create", path: "faq.md", file_text: "x" },
  { command: "create", path: "sub/new.md", file_text: "Hello\n" },
  { command: "view", path: "sub" },
  { command: "view", path: "faq.md" },
  { command: "view", path: "missing.md" },
  { command: "view", path: "../faq.md" },
  { command: "delete", path: "faq.md" },
  { path: "faq.md" },
];

test("the same answers and the same files as the Python version", { skip: PYTHON_VENV ? false : "Python environment missing" }, () => {
  writeFileSync(join(folder, "windows.md"), "Line one\r\nLine two\r\n", "utf8");
  const copy = mkdtempSync(join(tmpdir(), "editor-python-"));
  cpSync(folder, copy, { recursive: true });
  const ts = SEQUENCE.map((input, n) => editor.result({ id: `t${n}`, input }));
  const script = `
import json, sys
from pathlib import Path
from types import SimpleNamespace
from comptoir.editor import Editor
editor = Editor(sys.argv[1])
sequence = json.load(sys.stdin)
results = [editor.result(SimpleNamespace(id=f"t{n}", input=e)) for n, e in enumerate(sequence)]
files = {p.relative_to(sys.argv[1]).as_posix(): p.read_text(encoding="utf-8")
         for p in sorted(Path(sys.argv[1]).rglob("*")) if p.is_file()}
print(json.dumps({"results": results, "files": files}))`;
  const python = JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script, copy], {
      cwd: PYTHON,
      input: JSON.stringify(SEQUENCE),
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    }),
  );
  assert.deepEqual(ts, python.results);
  // Python writes the system's line endings (\r\n on Windows), TypeScript always \n: the text is compared,
  // read on both sides with the line endings brought back to \n.
  const files = Object.fromEntries(
    (readdirSync(folder, { recursive: true }) as string[])
      .filter((name) => statSync(join(folder, name)).isFile())
      .map((name) => [name.split(sep).join("/"), readFileSync(join(folder, name), "utf8").replace(/\r\n/g, "\n")]),
  );
  assert.deepEqual(files, python.files);
});
