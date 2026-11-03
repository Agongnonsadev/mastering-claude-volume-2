// Chapter 20: what Claude ran or changed, in a local log (PostToolUse hook).
//
// One JSON line per command or per file: the date, the session, the tool, the command or the path. Never the
// content of a file nor the output of a command: the log says what happened, not what was read.
// It is used to reread a long or unattended session, like the Comptoir's call log (chapter 2). It stays on
// the workstation (.claude/.gitignore). A program without dependencies, run by Node alone.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LOG = join(".claude", "tool-log.jsonl");

const event = JSON.parse(readFileSync(0, "utf8"));
const args = event.tool_input ?? {};
const line = {
  date: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
  session: event.session_id ?? null,
  tool: event.tool_name ?? null,
  target: [...String(args.command || args.file_path || "")].slice(0, 500).join(""),
};
const path = join(process.env.CLAUDE_PROJECT_DIR || ".", LOG);
mkdirSync(dirname(path), { recursive: true });
appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
