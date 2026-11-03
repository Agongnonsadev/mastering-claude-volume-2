// Chapter 20: no secret leaves in a commit (PreToolUse hook, on “git commit”).
//
// Before Claude runs a commit, the hook reads what is going to be recorded: the staged changes, and also the
// modified or new files when the command adds them itself (git add … && git commit, git commit -a). An
// Anthropic API key, a Meta token, a private key, a secret written in plain text (MY_API_KEY=…, TOKEN = "…"),
// or a .env file: the commit is blocked (code 2), and Claude reads why.
// Demonstration values (“replace-me”, “…-test”, “fake”) get through.
//
// The patterns are those of the Python version's hook (python/.claude/hooks/secret_guard.py), which also
// serves in the secret-guard plugin (tome-2-en/code/claude-tools). A key that has left the machine is changed,
// even if the commit is cancelled: it says so. A program without dependencies, run by Node alone.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Names in capitals: environment variables and constants. The secret="…" argument of a test is not one.
const SECRET_NAME = String.raw`\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|_SALT)[A-Z0-9_]*`;
const DUMMY = String.raw`(?![^"'\s]*(?:replace|example|test|fake|dummy|local|trial|xxxx))`;
const PATTERNS: [string, RegExp][] = [
  ["an Anthropic API key", /sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,}/],
  ["a Meta access token", /\bEAA[A-Za-z0-9]{60,}/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // NAME=value, alone on its line (.env file, shell), or NAME = "value" (code); not NAME = process.env…
  ["a secret written in plain text", new RegExp(
    String.raw`^\s*(?:export\s+)?${SECRET_NAME}\s*=\s*${DUMMY}[^\s"'$<{#]{8,}\s*$` +
      String.raw`|\b${SECRET_NAME}\s*[=:]\s*["']${DUMMY}[^"'\s$<{]{8,}["']`,
  )],
];
// .env.example contains only dummy values: allowed. The other .env files, no.
const FORBIDDEN_FILE = /(?:^|\/)\.env(?:\.(?!example$)[^/]+)?$|\.pem$|(?:^|\/)\.env\.txt$/;
const ADDS_ITSELF = /\bgit\s+add\b|\bgit\s+commit\b[^&|;]*\s(?:-[a-zA-Z]*a[a-zA-Z]*|--all)\b/;

// No check of the return code: “git diff --no-index” returns 1 when it finds a difference.
const git = (cwd: string, ...args: string[]): string => spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).stdout ?? "";

/** [file, line number, text] for each added line of a unified diff without context. */
function* addedLines(diff: string): Generator<[string, number, string]> {
  let file = "";
  let number = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) file = line.startsWith("+++ b/") ? line.slice(6) : "";
    else if (line.startsWith("@@")) number = Number(/\+(\d+)/.exec(line)![1]);
    else if (line.startsWith("+") && file) yield [file, number++, line.slice(1)];
  }
}

const mask = (secret: string): string => (secret.length > 6 ? secret.slice(0, 6) + "…" : "…");

function find(cwd: string, command: string): string[] {
  const everything = ADDS_ITSELF.test(command);
  const diffs = [git(cwd, "diff", "--cached", "-U0", "--no-color")];
  const names = git(cwd, "diff", "--cached", "--name-only").split(/\r?\n/).filter(Boolean);
  if (everything) {
    diffs.push(git(cwd, "diff", "-U0", "--no-color"));
    names.push(...git(cwd, "diff", "--name-only").split(/\r?\n/).filter(Boolean));
    const added = git(cwd, "ls-files", "--others", "--exclude-standard").split(/\r?\n/).filter(Boolean);
    names.push(...added);
    for (const name of added) diffs.push(git(cwd, "diff", "--no-index", "-U0", "--no-color", "/dev/null", name));
  }
  const findings = [...new Set(names)].filter((name) => FORBIDDEN_FILE.test(name)).map((name) => `${name}: a secrets file never goes into Git`);
  for (const diff of diffs) {
    for (const [file, number, text] of addedLines(diff)) {
      for (const [kind, pattern] of PATTERNS) {
        const found = pattern.exec(text);
        if (found) findings.push(`${file}:${number}: ${kind} (${mask(found[0].trim())})`);
      }
    }
  }
  for (const [kind, pattern] of PATTERNS.slice(0, 3)) { // the commit message, too
    const found = pattern.exec(command);
    if (found) findings.push(`the commit message: ${kind} (${mask(found[0])})`);
  }
  return findings;
}

function main(): number {
  const event = JSON.parse(readFileSync(0, "utf8"));
  const command: string = event.tool_input?.command ?? "";
  if (!/\bgit\s+commit\b/.test(command)) return 0;
  const findings = find(event.cwd || ".", command);
  if (!findings.length) return 0;
  process.stderr.write(
    "Commit blocked by the secret guard:\n- " + findings.join("\n- ") +
      "\nRemove these lines or these files from the commit (git restore --staged <file>), put the secret in the " +
      "environment, and warn the person in charge: a secret that may have left the machine is changed.\n",
  );
  return 2;
}

process.exitCode = main();
