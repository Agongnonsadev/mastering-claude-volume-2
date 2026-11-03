"""Chapter 20: the Comptoir's hooks, Skills, subagents, plugin and workflows.
No call to the API: the hooks run on manufactured events, in temporary Git repositories."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

PYTHON = Path(__file__).resolve().parents[1]           # the python/ folder, root of the project
REPOSITORY = PYTHON.parent                               # tome-2-en/code, the future companion repository
HOOKS = PYTHON / ".claude" / "hooks"
# A key in the real format, built at run time: written in one piece here, it would block the commit of this file.
KEY = "sk-ant-" + "api03-" + "Zx9" * 12


def hook(name: str, event: dict, root: Path = PYTHON, **env) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(HOOKS / f"{name}.py")], input=json.dumps(event).encode("utf-8"),
                          capture_output=True, env={**os.environ, "CLAUDE_PROJECT_DIR": str(root), **env})


def decision(result: subprocess.CompletedProcess) -> tuple[str, str] | None:
    output = result.stdout.decode("utf-8").strip()
    if not output:
        return None
    data = json.loads(output)["hookSpecificOutput"]
    return data["permissionDecision"], data["permissionDecisionReason"]


def git_repo(tmp_path: Path) -> Path:
    for command in (["init", "-q"], ["config", "user.email", "yao@example.test"], ["config", "user.name", "Yao"],
                    ["config", "core.autocrlf", "false"]):
        subprocess.run(["git", *command], cwd=tmp_path, check=True)
    (tmp_path / "comptoir.py").write_text("def total():\n    return 1\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "start"], cwd=tmp_path, check=True)
    return tmp_path


def commit(repo: Path, command: str = "git commit -m trial") -> subprocess.CompletedProcess:
    return hook("secret_guard", {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": str(repo)})


# --- The file guard ------------------------------------------------------------------------------------

def test_a_published_prompt_version_is_not_modified_but_the_next_one_is_written():
    existing = {"tool_name": "Edit", "tool_input": {"file_path": str(PYTHON / "comptoir/prompts/system_v5.md"),
                                                   "old_string": "a", "new_string": "b"}}
    kind, reason = decision(hook("file_guard", existing))
    assert kind == "deny" and "system_v6.md" in reason
    new = {"tool_name": "Write", "tool_input": {"file_path": str(PYTHON / "comptoir/prompts/system_v99.md"),
                                               "content": "New version"}}
    assert decision(hook("file_guard", new)) is None


@pytest.mark.parametrize("content, refused", [
    ("client = anthropic.Anthropic()", True),
    ("client = make_client()", True),
    ('AsyncAnthropic(api_key="x", base_url="https://api.anthropic.com")', True),
    ('AsyncAnthropic(api_key="fake-key", base_url=f"http://127.0.0.1:{port}", max_retries=0)', False),  # chapter 6
    ("client = FakeClient(text('Hello'))", False),
])
def test_a_test_never_calls_the_api(content, refused):
    event = {"tool_name": "Write", "tool_input": {"file_path": str(PYTHON / "tests/test_new.py"),
                                                 "content": content}}
    result = decision(hook("file_guard", event))
    assert (result is not None and result[0] == "deny") is refused
    # Outside tests/, the same code is allowed: it is the Comptoir.
    event["tool_input"]["file_path"] = str(PYTHON / "comptoir/call.py")
    assert decision(hook("file_guard", event)) is None


def test_a_change_to_the_prices_is_confirmed_by_yao():
    event = {"tool_name": "Edit", "tool_input": {"file_path": str(PYTHON / "comptoir/costs.py"),
                                                "old_string": "0.10", "new_string": "0.12"}}
    kind, reason = decision(hook("file_guard", event))
    assert kind == "ask" and "dated source" in reason


# --- The secret guard ----------------------------------------------------------------------------------

def test_a_staged_key_blocks_the_commit_without_being_copied(tmp_path):
    repo = git_repo(tmp_path)
    (repo / "settings.py").write_text(f'KEY = "{KEY}"\n', encoding="utf-8")
    subprocess.run(["git", "add", "settings.py"], cwd=repo, check=True)
    result = commit(repo)
    message = result.stderr.decode("utf-8")
    assert result.returncode == 2 and "settings.py:1" in message and "an Anthropic API key" in message
    assert KEY not in message  # the message shows the start, never the key


def test_an_env_file_blocks_the_commit_but_not_the_example(tmp_path):
    repo = git_repo(tmp_path)
    (repo / ".env.example").write_text("ANTHROPIC_API_KEY=replace-me\n", encoding="utf-8")
    subprocess.run(["git", "add", ".env.example"], cwd=repo, check=True)
    assert commit(repo).returncode == 0
    (repo / ".env").write_text("ANTHROPIC_API_KEY=a-real-key-value\n", encoding="utf-8")
    subprocess.run(["git", "add", ".env"], cwd=repo, check=True)
    result = commit(repo)
    assert result.returncode == 2 and "secrets file" in result.stderr.decode("utf-8")


def test_the_files_the_command_adds_itself_are_read(tmp_path):
    repo = git_repo(tmp_path)
    (repo / "notes.txt").write_text(f"my key: {KEY}\n", encoding="utf-8")  # not staged yet
    assert commit(repo, "git commit -m alone").returncode == 0            # this commit does not take it
    assert commit(repo, "git add -A && git commit -m all").returncode == 2
    assert commit(repo, f"git commit -m '{KEY}'").returncode == 2         # nor in the message


@pytest.mark.parametrize("line", [
    'DASHBOARD_TOKEN = os.environ.get("COMPTOIR_DASHBOARD_TOKEN", "")',  # a read, not a value
    'SECRET, VERIFICATION, SALT, TOKEN = "test-secret", "verif", "salt", "t"',  # test values
    'r = post(http, message, secret="another-secret")',                  # an argument, not a constant
    'monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key")',        # not the format of a real key
])
def test_ordinary_code_blocks_nothing(tmp_path, line):
    repo = git_repo(tmp_path)
    (repo / "module.py").write_text(line + "\n", encoding="utf-8")
    subprocess.run(["git", "add", "module.py"], cwd=repo, check=True)
    assert commit(repo).returncode == 0


def test_a_command_other_than_git_commit_gets_through(tmp_path):
    repo = git_repo(tmp_path)
    (repo / "notes.txt").write_text(f"{KEY}\n", encoding="utf-8")
    subprocess.run(["git", "add", "notes.txt"], cwd=repo, check=True)
    assert commit(repo, "git status").returncode == 0


# --- The end-of-turn hook ------------------------------------------------------------------------------

def end_of_turn(repo: Path, code: int) -> subprocess.CompletedProcess:
    command = f'"{sys.executable}" -c "import sys; print(\'1 failed\'); sys.exit({code})"'
    return hook("end_of_turn", {"hook_event_name": "Stop", "stop_hook_active": False}, root=repo,
                COMPTOIR_HOOK_TESTS=command)


def test_red_tests_prevent_claude_from_handing_back(tmp_path):
    repo = git_repo(tmp_path)
    assert end_of_turn(repo, 1).stdout == b""                  # nothing has changed: no tests
    (repo / "comptoir.py").write_text("def total():\n    return 2\n", encoding="utf-8")
    output = json.loads(end_of_turn(repo, 1).stdout.decode("utf-8"))
    assert output["decision"] == "block" and "1 failed" in output["reason"]
    assert end_of_turn(repo, 0).stdout == b""                  # green: the fingerprint is recorded
    assert end_of_turn(repo, 1).stdout == b""                  # same state: the suite does not run again
    (repo / "new.py").write_text("x = 1\n", encoding="utf-8")
    assert json.loads(end_of_turn(repo, 1).stdout.decode("utf-8"))["decision"] == "block"


def test_the_tool_log_records_the_command_but_never_the_content(tmp_path):
    hook("tool_log", {"session_id": "s1", "tool_name": "Write",
                      "tool_input": {"file_path": "notes.md", "content": "a private content"}}, root=tmp_path)
    hook("tool_log", {"session_id": "s1", "tool_name": "Bash", "tool_input": {"command": "python -m pytest -q"},
                      "tool_response": {"stdout": "452 passed"}}, root=tmp_path)
    lines = [json.loads(l) for l in (tmp_path / ".claude/tool-log.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [(l["tool"], l["target"]) for l in lines] == [("Write", "notes.md"), ("Bash", "python -m pytest -q")]
    assert "private" not in json.dumps(lines, ensure_ascii=False) and "452" not in json.dumps(lines)


# --- The configuration: settings, Skills, subagents, plugin --------------------------------------------

def header(path: Path) -> dict:
    """The simple fields of the YAML header of a Markdown file (key: value)."""
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---\n"), path
    block = text.split("---\n", 2)[1]
    return {m.group(1): m.group(2).strip().strip('"') for m in re.finditer(r"^([a-zA-Z-]+):\s*(.*)$", block, re.M)}


def test_each_hook_of_the_settings_points_to_a_script_that_exists():
    settings = json.loads((PYTHON / ".claude/settings.json").read_text(encoding="utf-8"))
    commands = [h["command"] for groups in settings["hooks"].values() for g in groups for h in g["hooks"]]
    assert commands
    for command in commands:
        name = re.search(r"run\.sh\" (\w+)$", command).group(1)
        assert (HOOKS / f"{name}.py").exists(), name
    assert "Bash(python -m ch*)" in settings["permissions"]["ask"]  # the paid scripts always ask


def test_the_skills_and_the_subagents_are_complete():
    skills = {d.name: header(d / "SKILL.md") for d in (PYTHON / ".claude/skills").iterdir()}
    agents = {f.stem: header(f) for f in (PYTHON / ".claude/agents").glob("*.md")}
    assert set(skills) == {"verify", "peer-review", "new-variant", "regression"}
    assert all(s.get("description") for s in skills.values())
    # The Skills that cost money, or that have an effect, run only on request.
    assert skills["regression"]["disable-model-invocation"] == "true"
    assert skills["new-variant"]["disable-model-invocation"] == "true"
    assert skills["peer-review"]["context"] == "fork" and skills["peer-review"]["agent"] in agents
    assert all(a.get("name") and a.get("description") and a.get("tools") for a in agents.values())
    assert "Edit" not in agents["reviewer"]["tools"] and "Write" not in agents["reviewer"]["tools"]


def test_the_per_folder_rules_target_files_that_exist():
    for rule in (PYTHON / ".claude/rules").glob("*.md"):
        patterns = re.findall(r'^\s+- "([^"]+)"', rule.read_text(encoding="utf-8"), re.M)
        assert patterns, rule.name
        assert all(list(PYTHON.glob(p)) for p in patterns), rule.name


def test_the_plugin_takes_up_the_comptoirs_guard_and_declares_its_dependency():
    marketplace = REPOSITORY / "claude-tools"
    catalog = json.loads((marketplace / ".claude-plugin/marketplace.json").read_text(encoding="utf-8"))
    for entry in catalog["plugins"]:
        manifest = json.loads((marketplace / entry["source"] / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))
        assert manifest["name"] == entry["name"]
    peer_review = json.loads((marketplace / "plugins/peer-review/.claude-plugin/plugin.json").read_text(encoding="utf-8"))
    assert peer_review["dependencies"] == ["secret-guard"]
    copy = marketplace / "plugins/secret-guard/scripts/secret_guard.py"
    assert copy.read_bytes() == (HOOKS / "secret_guard.py").read_bytes()  # a single version of the guard


# --- The workflows -------------------------------------------------------------------------------------

def test_the_workflows_have_no_key_and_bound_what_costs_money():
    tests = (REPOSITORY / ".github/workflows/tests.yml").read_text(encoding="utf-8")
    claude = (REPOSITORY / ".github/workflows/claude.yml").read_text(encoding="utf-8")
    assert "secrets." not in tests + claude                       # identity federation, no stored key
    assert "id-token" not in tests and "anthropic" not in tests.lower()  # the tests have no access to Claude
    assert claude.count("id-token: write") == 2
    # Neither a copy of the repository (fork) nor a draft; a spending ceiling; a maximum duration for each job.
    assert claude.count("github.event.pull_request.head.repo.full_name == github.repository") == 2
    assert "--max-budget 0.3" in claude and "--max-turns" in claude
    assert claude.count("timeout-minutes:") == 2 and tests.count("timeout-minutes:") == 1
    # The reviewer's instructions come from main, not from the pull request it reviews.
    assert 'git checkout "origin/${{ github.base_ref }}" -- "$path"' in claude
