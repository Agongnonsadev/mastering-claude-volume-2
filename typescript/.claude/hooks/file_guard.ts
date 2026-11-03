// Chapter 20: what Claude Code does not change without Yao seeing it (PreToolUse hook, Edit and Write).
//
// CLAUDE.md asks for these rules; this hook enforces them, every time, without Claude having to remember them:
// - a prompt version is not changed: the next one is written, and evaluated (chapters 5 and 17); the prompts,
//   shared by the two versions, are in ../python/comptoir/prompts;
// - a test never calls the API: no real client in tests/, except toward a fake local server;
// - the prices of comptoir/costs.ts come from Anthropic's Pricing page: Yao confirms each change.
//
// Input: the event as JSON on standard input. Output: nothing (no objection), or a “deny” or “ask” decision
// with its reason, which Claude reads. A program without dependencies, run by Node alone.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const VERSIONED_PROMPT = /^(?:\.\.\/python\/)?comptoir\/prompts\/[a-z_]+_v\d+\.md$/;
const CLIENT = /\bnew\s+Anthropic\s*\(|\bmakeClient\s*\(/g;
const LOCAL_SERVER = /baseURL\s*:\s*[`"']https?:\/\/(?:127\.0\.0\.1|localhost)/;

type Arguments = { file_path?: string; content?: string; new_string?: string; edits?: { new_string?: string }[] };

/** The file's path relative to the project, with forward slashes, under Windows too. */
function relativePath(path: string, root: string): string {
  if (!path) return "";
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  return relative(resolve(root), absolute).replaceAll("\\", "/");
}

/** What the tool is going to write: the content of Write, the new text of Edit (or of each grouped Edit). */
function writtenTexts(args: Arguments): string[] {
  return [args.content ?? "", args.new_string ?? "", ...(args.edits ?? []).map((e) => e.new_string ?? "")].filter(Boolean);
}

/** A real client, or makeClient(): forbidden in a test. A client toward 127.0.0.1 stays allowed (a fake server). */
function callsTheApi(text: string): boolean {
  for (const found of text.matchAll(CLIENT)) {
    if (found[0].startsWith("makeClient")) return true;
    const end = found.index + found[0].length;
    if (!LOCAL_SERVER.test(text.slice(end, end + 400))) return true;
  }
  return false;
}

function examine(event: { tool_input?: Arguments }, root: string): [string, string] | null {
  const args = event.tool_input ?? {};
  const file = relativePath(args.file_path ?? "", root);
  if (VERSIONED_PROMPT.test(file) && existsSync(join(root, file))) {
    const version = Number(/_v(\d+)\.md$/.exec(file)![1]);
    const nextVersion = file.replace(/_v\d+\.md$/, `_v${version + 1}.md`);
    return ["deny", `${file} is a published version: evaluation series refer to it by its fingerprint. ` +
      `Write the next version (${nextVersion}), then evaluate it as a variant (chapter 17).`];
  }
  if (file.startsWith("tests/") && writtenTexts(args).some(callsTheApi)) {
    return ["deny", "A test never calls the API: each call is paid. Use a fake client " +
      "(see FakeClient in tests/fake_clients.ts), or a fake server on 127.0.0.1."];
  }
  if (file === "comptoir/costs.ts") {
    return ["ask", "The prices in comptoir/costs.ts come from Anthropic's Pricing page. " +
      "Does the change have a dated source? Yao confirms it himself."];
  }
  return null;
}

function main(): void {
  const event = JSON.parse(readFileSync(0, "utf8"));
  const root = process.env.CLAUDE_PROJECT_DIR || event.cwd || ".";
  const result = examine(event, root);
  if (result) {
    const [decision, reason] = result;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } }) + "\n");
  }
}

main();
