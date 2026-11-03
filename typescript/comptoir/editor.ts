// Anthropic's text editor tool, run by your code in a closed folder (chapter 10).
//
// Anthropic defines the tool (text_editor_20250728, named str_replace_based_edit_tool): its schema, and
// the way Claude uses it. Your code runs it. So it has all the responsibilities of access to files:
// staying in its folder, refusing an ambiguous replacement, backing up before modifying.

import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { splitLines } from "./diff.ts";

export const TOOL: Anthropic.ToolTextEditor20250728 = { type: "text_editor_20250728", name: "str_replace_based_edit_tool", max_characters: 20000 };

export class EditorRefusal extends Error {}

export interface Input {
  command?: string;
  path?: string;
  view_range?: [number, number] | null;
  old_str?: string;
  new_str?: string;
  file_text?: string;
  insert_line?: number;
  insert_text?: string;
}

/** A file read as read_text() does in Python: strict UTF-8, line endings brought back to “\n”. */
export function readText(file: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file)).replace(/\r\n?/g, "\n");
  } catch (error) {
    if (error instanceof TypeError) throw new EditorRefusal("Error: File is not valid UTF-8.");
    throw error;
  }
}

/** A path whose symbolic links are resolved, even if it does not exist yet (Path.resolve). */
function real(path: string): string {
  let base = resolve(path);
  const rest: string[] = [];
  while (!existsSync(base) && dirname(base) !== base) {
    rest.unshift(basename(base));
    base = dirname(base);
  }
  return join(realpathSync.native(base), ...rest);
}

/** A required field of the input. Missing, it gives the same message as a KeyError in Python. */
function field<K extends keyof Input>(input: Input, name: K): NonNullable<Input[K]> {
  const value = input[name];
  if (value === undefined || value === null) throw new EditorRefusal(`'${name}'`);
  return value;
}

export class Editor {
  readonly root: string;

  constructor(root: string) {
    this.root = real(root);
  }

  /** A relative path, which stays in the root. No “..”, no absolute path. */
  private path(path: string): string {
    const candidate = real(resolve(this.root, path));
    const inside = candidate === this.root || candidate.startsWith(this.root + sep);
    if (isAbsolute(path) || !inside) throw new EditorRefusal(`Error: Path outside the allowed folder: ${path}`);
    return candidate;
  }

  private backUp(file: string): void {
    if (existsSync(file)) writeFileSync(`${file}.backup`, readText(file), "utf8");
  }

  execute(input: Input): string {
    const command = input.command;
    const file = this.path(field(input, "path"));
    if (command === "view") {
      if (existsSync(file) && statSync(file).isDirectory()) {
        return readdirSync(file).map((name) => relative(this.root, join(file, name)).split(sep).join("/")).sort().join("\n");
      }
      if (!existsSync(file)) throw new EditorRefusal("Error: File not found");
      const lines = splitLines(readText(file));
      const [start, requestedEnd] = input.view_range || [1, -1];
      const end = requestedEnd === -1 ? lines.length : requestedEnd;
      // Line numbers, so that Claude can aim an insertion.
      const out: string[] = [];
      for (let n = start; n <= end; n++) if (n > 0 && n <= lines.length) out.push(`${n}: ${lines[n - 1]}`);
      return out.join("\n");
    }
    if (command === "str_replace") {
      if (!existsSync(file)) throw new EditorRefusal("Error: File not found");
      const content = readText(file);
      const old = field(input, "old_str");
      // Like str.count in Python: an empty string is found between each character.
      const count = old ? content.split(old).length - 1 : [...content].length + 1;
      if (count === 0) throw new EditorRefusal("Error: No match found for replacement. Please check your text and try again.");
      if (count > 1) throw new EditorRefusal(`Error: Found ${count} matches for replacement text. Please provide more context to make a unique match.`);
      const replacement = field(input, "new_str");
      this.backUp(file);
      writeFileSync(file, content.replace(old, () => replacement), "utf8");
      return "Successfully replaced text at exactly one location.";
    }
    if (command === "create") {
      if (existsSync(file)) throw new EditorRefusal("Error: File already exists. Use str_replace to modify it.");
      const text = field(input, "file_text");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, "utf8");
      return `File created: ${input.path}`;
    }
    if (command === "insert") {
      if (!existsSync(file)) throw new EditorRefusal("Error: File not found");
      const lines = splitLines(readText(file), true);
      const position = field(input, "insert_line");
      if (!(position >= 0 && position <= lines.length)) throw new EditorRefusal(`Error: insert_line must be between 0 and ${lines.length}.`);
      const added = field(input, "insert_text");
      this.backUp(file);
      const text = added.endsWith("\n") ? added : `${added}\n`;
      writeFileSync(file, [...lines.slice(0, position), text, ...lines.slice(position)].join(""), "utf8");
      return `Text inserted after line ${position}.`;
    }
    throw new EditorRefusal(`Error: Unknown command ${command === undefined ? "None" : `'${command}'`}.`);
  }

  /** A tool_use block of the editor in, a tool_result out. */
  result(call: Pick<Anthropic.ToolUseBlock, "id" | "input">): Anthropic.ToolResultBlockParam {
    try {
      return { type: "tool_result", tool_use_id: call.id, content: this.execute(call.input as Input) };
    } catch (error) {
      if (!(error instanceof EditorRefusal)) throw error;
      return { type: "tool_result", tool_use_id: call.id, content: error.message, is_error: true };
    }
  }
}
