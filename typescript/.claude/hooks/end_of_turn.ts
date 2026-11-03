// Chapter 20: Claude does not hand back on red tests (Stop hook).
//
// When Claude has finished answering, the hook looks at whether TypeScript code has changed since the last
// green run. If so, the test suite runs (without a paid call: a fake client everywhere). Red: the hook sends
// back the end of the report with “decision: block”, and Claude continues to fix it, or explains why the
// failure is expected. Green: the fingerprint of the changes is recorded, so as not to rerun the same suite.
//
// Claude Code itself stops the loop after eight relaunches in a row (hooks documentation).
// COMPTOIR_HOOK_TESTS replaces the test command (for the hook's tests). A program without dependencies.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STATE = join(".claude", ".last-green"); // ignored by Git (.claude/.gitignore)

const git = (root: string, ...args: string[]): string =>
  spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).stdout ?? "";

/** The state of the TypeScript code compared with the last commit: changed, added or new. Empty if nothing changed. */
function fingerprint(root: string): string {
  const diff = git(root, "diff", "HEAD", "--no-color", "--", "*.ts");
  const added = git(root, "ls-files", "--others", "--exclude-standard", "--", "*.ts").split(/\s+/).filter(Boolean);
  if (!diff && !added.length) return "";
  const h = createHash("sha256").update(diff, "utf8");
  for (const name of added.sort()) {
    h.update(name, "utf8");
    h.update(readFileSync(join(root, name)));
  }
  return h.digest("hex");
}

/**
 * Python's shlex.split, simpler: words separated by spaces, in quotes if needed. Between double quotes, a
 * backslash only escapes \ " $ and `: a Windows path stays intact.
 */
function words(command: string): string[] {
  return [...command.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\([\\"$`])/g, "$1") : (m[2] ?? m[3]!)));
}

function main(): void {
  readFileSync(0, "utf8"); // the Stop event: nothing to read in it
  const root = process.env.CLAUDE_PROJECT_DIR || ".";
  const current = fingerprint(root);
  const state = join(root, STATE);
  if (!current || (existsSync(state) && readFileSync(state, "utf8") === current)) return;
  const replaced = words(process.env.COMPTOIR_HOOK_TESTS ?? "");
  const [command, ...args] = replaced.length
    ? replaced
    : [process.execPath, "--disable-warning=ExperimentalWarning", "--import", "tsx", "--test", "--test-reporter=dot", "tests/**/*.test.ts"];
  const result = spawnSync(command!, args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status === 0) {
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, current, "utf8"); // the fingerprint of the changes that went green
    return;
  }
  const tail = ((result.stdout ?? "") + (result.stderr ?? "")).trim().split(/\r?\n/).slice(-25).join("\n");
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: "The test suite fails after your changes. Fix it before handing back, or explain to Yao " +
      "why the failure is expected. End of the report:\n" + tail,
  }) + "\n");
}

main();
