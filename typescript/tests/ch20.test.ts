// Chapter 20: the hooks, the Skills, the subagents and the workflow of the TypeScript version. No call to the
// API: the hooks run on manufactured events, in temporary Git repositories. The tests of
// python/tests/test_ch20.py, for the configuration of this folder (.claude/, CLAUDE.md).

import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, globSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { ROOT } from "../comptoir/launch.ts";

const HOOKS = join(ROOT, ".claude", "hooks");
const REPOSITORY = join(ROOT, ".."); // tome-2-en/code, the future companion repository
// A key in the real format, built at run time: written in one piece here, it would block the commit of this file.
const KEY = "sk-ant-" + "api03-" + "Zx9".repeat(12);

/** The hook, run as Claude Code runs it (by Node alone, without tsx), on a manufactured event. */
function hook(name: string, event: object, root = ROOT, env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(HOOKS, `${name}.ts`)], {
    input: JSON.stringify(event), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
}

function decision(r: SpawnSyncReturns<string>): [string, string] | null {
  const output = r.stdout.trim();
  if (!output) return null;
  const d = JSON.parse(output).hookSpecificOutput;
  return [d.permissionDecision, d.permissionDecisionReason];
}

const git = (cwd: string, ...args: string[]): void => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

function gitRepo(): string {
  const folder = mkdtempSync(join(tmpdir(), "ch20-"));
  for (const args of [["init", "-q"], ["config", "user.email", "yao@example.test"], ["config", "user.name", "Yao"], ["config", "core.autocrlf", "false"]]) git(folder, ...args);
  writeFileSync(join(folder, "comptoir.ts"), "export const total = (): number => 1;\n", "utf8");
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "start");
  return folder;
}

const commit = (repo: string, command = "git commit -m trial"): SpawnSyncReturns<string> =>
  hook("secret_guard", { tool_name: "Bash", tool_input: { command }, cwd: repo });

// --- The file guard ------------------------------------------------------------------------------------

test("a published prompt version is not modified, but the next one is written", () => {
  // The prompts are shared by the two versions: they live in ../python/comptoir/prompts.
  const existing = { tool_name: "Edit", tool_input: { file_path: join(ROOT, "..", "python", "comptoir", "prompts", "system_v5.md"), old_string: "a", new_string: "b" } };
  const [kind, reason] = decision(hook("file_guard", existing))!;
  assert.ok(kind === "deny" && reason.includes("system_v6.md"), reason);
  const fresh = { tool_name: "Write", tool_input: { file_path: join(ROOT, "..", "python", "comptoir", "prompts", "system_v99.md"), content: "New version" } };
  assert.equal(decision(hook("file_guard", fresh)), null);
});

test("a test never calls the API", () => {
  const cases: [string, boolean][] = [
    ["const client = new Anthropic();", true],
    ["const client = makeClient();", true],
    ['new Anthropic({ apiKey: "x", baseURL: "https://api.anthropic.com" })', true],
    ["new Anthropic({ apiKey: \"fake-key\", baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 })", false], // a fake local server
    ['const client = new FakeClient(text("Hello"));', false],
  ];
  for (const [content, refused] of cases) {
    const event = { tool_name: "Write", tool_input: { file_path: join(ROOT, "tests", "new.test.ts"), content } };
    const r = decision(hook("file_guard", event));
    assert.equal(r !== null && r[0] === "deny", refused, content);
    // Outside tests/, the same code is allowed: it is the Comptoir.
    event.tool_input.file_path = join(ROOT, "comptoir", "call.ts");
    assert.equal(decision(hook("file_guard", event)), null, content);
  }
});

test("a change to the prices is confirmed by Yao", () => {
  const event = { tool_name: "Edit", tool_input: { file_path: join(ROOT, "comptoir", "costs.ts"), old_string: "0.1", new_string: "0.12" } };
  const [kind, reason] = decision(hook("file_guard", event))!;
  assert.ok(kind === "ask" && reason.includes("dated source"));
});

// --- The secret guard ----------------------------------------------------------------------------------

test("a staged key blocks the commit, without being copied", () => {
  const repo = gitRepo();
  writeFileSync(join(repo, "settings.ts"), `export const KEY = "${KEY}";\n`, "utf8");
  git(repo, "add", "settings.ts");
  const r = commit(repo);
  assert.ok(r.status === 2 && r.stderr.includes("settings.ts:1") && r.stderr.includes("an Anthropic API key"), r.stderr);
  assert.ok(!r.stderr.includes(KEY)); // the message shows the start, never the key
});

test("an .env file blocks the commit, but not the example", () => {
  const repo = gitRepo();
  writeFileSync(join(repo, ".env.example"), "ANTHROPIC_API_KEY=replace-me\n", "utf8");
  git(repo, "add", ".env.example");
  assert.equal(commit(repo).status, 0);
  writeFileSync(join(repo, ".env"), "ANTHROPIC_API_KEY=a-real-key-value\n", "utf8");
  git(repo, "add", ".env");
  const r = commit(repo);
  assert.ok(r.status === 2 && r.stderr.includes("secrets file"));
});

test("the files the command adds itself are read", () => {
  const repo = gitRepo();
  writeFileSync(join(repo, "notes.txt"), `my key: ${KEY}\n`, "utf8"); // not staged yet
  assert.equal(commit(repo, "git commit -m alone").status, 0); //      this commit does not take it
  assert.equal(commit(repo, "git add -A && git commit -m all").status, 2);
  assert.equal(commit(repo, `git commit -m '${KEY}'`).status, 2); //  nor in the message
});

test("ordinary code blocks nothing", () => {
  for (const line of [
    'const DASHBOARD_TOKEN = process.env.COMPTOIR_DASHBOARD_TOKEN ?? "";', //       a read, not a value
    'const [SECRET, VERIFICATION, SALT, TOKEN] = ["test-secret", "verif", "salt", "t"];', // test values
    'const r = await post(s, payload, "another-secret");', //                         an argument, not a constant
    'setConfig({ ANTHROPIC_API_KEY: "sk-ant-test-key" });', //                        not the format of a real key
  ]) {
    const repo = gitRepo();
    writeFileSync(join(repo, "module.ts"), line + "\n", "utf8");
    git(repo, "add", "module.ts");
    assert.equal(commit(repo).status, 0, line);
  }
});

test("a command other than git commit gets through", () => {
  const repo = gitRepo();
  writeFileSync(join(repo, "notes.txt"), `${KEY}\n`, "utf8");
  git(repo, "add", "notes.txt");
  assert.equal(commit(repo, "git status").status, 0);
});

// --- The end-of-turn hook ------------------------------------------------------------------------------

const endOfTurn = (repo: string, code: number): SpawnSyncReturns<string> =>
  hook("end_of_turn", { hook_event_name: "Stop", stop_hook_active: false }, repo, {
    COMPTOIR_HOOK_TESTS: `"${process.execPath}" -e "console.log('1 failed'); process.exit(${code})"`,
  });

test("red tests prevent Claude from handing back", () => {
  const repo = gitRepo();
  assert.equal(endOfTurn(repo, 1).stdout, ""); //                nothing has changed: no tests
  writeFileSync(join(repo, "comptoir.ts"), "export const total = (): number => 2;\n", "utf8");
  const output = JSON.parse(endOfTurn(repo, 1).stdout);
  assert.ok(output.decision === "block" && output.reason.includes("1 failed"));
  assert.equal(endOfTurn(repo, 0).stdout, ""); //                green: the fingerprint is recorded
  assert.equal(endOfTurn(repo, 1).stdout, ""); //                same state: the suite does not run again
  writeFileSync(join(repo, "new.ts"), "export const x = 1;\n", "utf8");
  assert.equal(JSON.parse(endOfTurn(repo, 1).stdout).decision, "block");
});

test("the tool log records the command, but never the content", () => {
  const folder = mkdtempSync(join(tmpdir(), "ch20-"));
  hook("tool_log", { session_id: "s1", tool_name: "Write", tool_input: { file_path: "notes.md", content: "a private content" } }, folder);
  hook("tool_log", { session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "452 passed" } }, folder);
  const lines = readFileSync(join(folder, ".claude", "tool-log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.tool, l.target]), [["Write", "notes.md"], ["Bash", "npm test"]]);
  assert.ok(!JSON.stringify(lines).includes("private") && !JSON.stringify(lines).includes("452"));
});

// --- The configuration: settings, Skills, subagents ----------------------------------------------------

/** The simple fields of the YAML header of a Markdown file (key: value). */
function header(path: string): Record<string, string> {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  assert.ok(text.startsWith("---\n"), path);
  const block = text.split("---\n")[1]!;
  return Object.fromEntries([...block.matchAll(/^([a-zA-Z-]+):\s*(.*)$/gm)].map((m) => [m[1], m[2]!.trim().replace(/^"|"$/g, "")]));
}

test("each hook of the settings points to a script that exists", () => {
  const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8"));
  const commands = Object.values(settings.hooks as Record<string, { hooks: { command: string }[] }[]>).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
  assert.ok(commands.length);
  for (const command of commands) {
    const name = /run\.sh" (\w+)$/.exec(command)![1]!;
    assert.ok(existsSync(join(HOOKS, `${name}.ts`)), name);
  }
  assert.ok(existsSync(join(HOOKS, "run.sh")));
  assert.ok(settings.permissions.ask.includes("Bash(npx tsx ch*)")); // the paid scripts always ask
});

test("the Skills and the subagents are complete", () => {
  const skillsFolder = join(ROOT, ".claude", "skills");
  const skills = Object.fromEntries(readdirSync(skillsFolder).map((d) => [d, header(join(skillsFolder, d, "SKILL.md"))]));
  const agentsFolder = join(ROOT, ".claude", "agents");
  const agents = Object.fromEntries(readdirSync(agentsFolder).filter((f) => f.endsWith(".md")).map((f) => [basename(f, ".md"), header(join(agentsFolder, f))]));
  assert.deepEqual(new Set(Object.keys(skills)), new Set(["verify", "peer-review", "new-variant", "regression"]));
  assert.ok(Object.values(skills).every((s) => s.description));
  // The Skills that cost money, or that have an effect, only run on request.
  assert.equal(skills.regression!["disable-model-invocation"], "true");
  assert.equal(skills["new-variant"]!["disable-model-invocation"], "true");
  assert.ok(skills["peer-review"]!.context === "fork" && skills["peer-review"]!.agent! in agents);
  assert.ok(Object.values(agents).every((a) => a.name && a.description && a.tools));
  assert.ok(!agents.reviewer!.tools!.includes("Edit") && !agents.reviewer!.tools!.includes("Write"));
});

test("the per-folder rules target files that exist", () => {
  const folder = join(ROOT, ".claude", "rules");
  for (const rule of readdirSync(folder).filter((f) => f.endsWith(".md"))) {
    const patterns = [...readFileSync(join(folder, rule), "utf8").matchAll(/^\s+- "([^"]+)"/gm)].map((m) => m[1]!);
    assert.ok(patterns.length, rule);
    for (const pattern of patterns) assert.ok(globSync(pattern, { cwd: ROOT }).length, `${rule}: ${pattern}`);
  }
});

test("the TypeScript version's workflow has no access to Claude, and a maximum duration", () => {
  const tests = readFileSync(join(REPOSITORY, ".github", "workflows", "tests-typescript.yml"), "utf8");
  assert.ok(!tests.includes("secrets.") && !tests.includes("id-token") && !tests.toLowerCase().includes("anthropic"));
  assert.equal((tests.match(/timeout-minutes:/g) ?? []).length, 1);
  for (const step of ["npm ci", "npm test", "npm run typecheck", "ch18/code_audit.ts"]) assert.ok(tests.includes(step), step);
});

test("CLAUDE.md states the rules and the commands of this version", () => {
  const memory = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
  for (const expected of ["npm test", "npm run typecheck", "npx tsx", "ANTHROPIC_API_KEY", "/verify", "../python/"]) assert.ok(memory.includes(expected), expected);
});
