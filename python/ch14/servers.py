"""Chapter 14: the chapter's MCP servers, in one place, each at a pinned version.

The two local servers are installed once in ch14/mcp/ (npm ci), and not downloaded
by npx at each launch: package-lock.json pins the package and its whole dependency tree,
and the signatures are checked with npm audit signatures. To change versions: reread the
project's page, edit ch14/mcp/package.json, reinstall, then run ch14.explore_server again
before plugging the server back into Claude (a test checks that .mcp.json still agrees).
"""

import json
from pathlib import Path

from mcp import StdioServerParameters

ROOT = Path(__file__).parents[1]
MODULES = ROOT / "ch14" / "mcp" / "node_modules"

# The entry points, as paths relative to the python/ folder: that is where Claude Code and
# the scripts launch the servers from.
DBHUB = "ch14/mcp/node_modules/@bytebase/dbhub/dist/index.js"
EVERYTHING = "ch14/mcp/node_modules/@modelcontextprotocol/server-everything/dist/index.js"
DOC_CLAUDE = "https://platform.claude.com/docs/mcp"  # the server of Anthropic's documentation

# DBHub on the exploration copy, read-only (see ch14/dbhub.toml).
DBHUB_ARGUMENTS = [DBHUB, "--transport", "stdio", "--config", "ch14/dbhub.toml"]


def installed_version(package: str) -> str:
    return json.loads((MODULES / package / "package.json").read_text(encoding="utf-8"))["version"]


def orders() -> StdioServerParameters:
    """The server of Awa's orders: a local program, launched by the client, which talks over stdio."""
    return StdioServerParameters(command="node", args=DBHUB_ARGUMENTS, cwd=str(ROOT),
                                 env={"CLAUDE_PROJECT_DIR": str(ROOT)})


def everything() -> StdioServerParameters:
    """The MCP project's demonstration server: sample tools, resources and prompts.
    2.0.0 (October 19, 2026) requires Node 24; 1.0.0 runs on Node 22."""
    return StdioServerParameters(command="node", args=[EVERYTHING, "stdio"], cwd=str(ROOT))


SERVERS = {"orders": orders, "everything": everything, "doc": lambda: DOC_CLAUDE}
