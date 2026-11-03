"""Chapter 15: makes the “Comptoir for Awa” desktop extension (.mcpb) from the server.

Run, from the python/ folder (free):
    python -m ch15.build_extension             # prepares ch15/build/comptoir-for-awa/
    python -m ch15.build_extension --package   # then validates and packages it with mcpb

The manifest is written by the code, from the server itself: the list of tools and
prompts it announces cannot diverge from what the server exposes. The package is of type
“uv” (manifest 0.4): the app installs Python and the dependencies of pyproject.toml, and
uv.lock pins the whole tree, like package-lock.json in chapter 14. For --package, you need the
tools of ch15/tools (npm ci) and uv (pip install uv).
"""

import argparse
import asyncio
import json
import shutil
import subprocess
from pathlib import Path

from mcp import Client

from ch15 import comptoir_for_awa as awa_server

ROOT = Path(__file__).parents[1]
NAME = "comptoir-for-awa"
BUILD = ROOT / "ch15" / "build"
FOLDER = BUILD / NAME
MCPB = ROOT / "ch15" / "tools" / "node_modules" / "@anthropic-ai" / "mcpb" / "dist" / "cli" / "cli.js"
MCP_VERSION = "2.3.0"  # the MCP SDK the server was tested with

SETTINGS = {
    "shop_database": {
        "type": "file",
        "title": "Shop database",
        "description": "The shop file that Yao gave you (shop.sqlite3). It stays on your computer: the "
                       "extension reads it, and changes only the stock in it, after your consent.",
        "required": True,
    },
}


def _first_sentence(text: str) -> str:
    text = " ".join((text or "").split())
    return text.split(". ")[0].rstrip(".") + "."


async def _inventory() -> tuple[list[dict], list[dict]]:
    """The tools and the prompts as the server announces them, read by an in-memory MCP client."""
    async with Client(awa_server.server) as client:
        tools = [{"name": t.name, "description": _first_sentence(t.description)}
                 for t in (await client.list_tools()).tools]
        prompts = []
        for p in (await client.list_prompts()).prompts:
            arguments = [a.name for a in (p.arguments or [])]
            rendered = await client.get_prompt(p.name, {a: f"${{arguments.{a}}}" for a in arguments})
            prompts.append({"name": p.name, "description": _first_sentence(p.description),
                            "arguments": arguments, "text": rendered.messages[0].content.text})
    return tools, prompts


def manifest(tools: list[dict], prompts: list[dict]) -> dict:
    return {
        "manifest_version": "0.4",
        "name": NAME,
        "display_name": "Comptoir for Awa",
        "version": awa_server.VERSION,
        "description": "Your orders, your stock and your sales of the week, in Claude.",
        "long_description": (
            "Comptoir for Awa connects Claude to the Délices d'Awa shop. Ask for your orders of the day, "
            "your stock or your sales of the week. After an inventory, Claude can correct the stock, "
            "but only after showing you the difference and getting your consent. No other data is "
            "changed. Example from the book “Mastering Claude”, Volume 2 (Botlyx Academy): fictional "
            "business and people."),
        "author": {"name": "Botlyx Academy", "url": "https://academy.botlyx.com"},
        "icon": "icon.png",
        "server": {
            "type": "uv",
            "entry_point": "src/server.py",
            "mcp_config": {
                "command": "uv",
                "args": ["run", "--directory", "${__dirname}", "src/server.py"],
                "env": {"COMPTOIR_SHOP": "${user_config.shop_database}"},
            },
        },
        "tools": tools,
        "prompts": prompts,
        "user_config": SETTINGS,
        "keywords": ["orders", "stock", "sales", "botlyx"],
        "license": "MIT",
        "compatibility": {"platforms": ["darwin", "win32"], "runtimes": {"python": ">=3.10"}},
    }


PYPROJECT = f"""[project]
name = "{NAME}"
version = "{awa_server.VERSION}"
description = "Comptoir for Awa: the MCP server of Délices d'Awa (example from Volume 2 of “Mastering Claude”)"
requires-python = ">=3.10"
dependencies = ["mcp=={MCP_VERSION}"]
"""


def icon(path: Path) -> None:
    """A simple icon: a bissap-colored disc, with a white “A”. 512 × 512, transparent background."""
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    drawing = ImageDraw.Draw(image)
    drawing.ellipse((16, 16, 496, 496), fill=(150, 20, 60, 255))
    font = ImageFont.load_default(size=300)
    drawing.text((256, 268), "A", fill=(255, 255, 255, 255), font=font, anchor="mm")
    image.save(path)


def prepare() -> Path:
    if FOLDER.exists():
        shutil.rmtree(FOLDER)
    (FOLDER / "src").mkdir(parents=True)
    shutil.copyfile(Path(awa_server.__file__), FOLDER / "src" / "server.py")
    shutil.copyfile(ROOT / "comptoir" / "data" / "delices_awa.json", FOLDER / "src" / "catalog.json")
    (FOLDER / "pyproject.toml").write_text(PYPROJECT, encoding="utf-8")
    (FOLDER / ".mcpbignore").write_text(".venv/\n__pycache__/\n*.pyc\n", encoding="utf-8")
    tools, prompts = asyncio.run(_inventory())
    (FOLDER / "manifest.json").write_text(json.dumps(manifest(tools, prompts), ensure_ascii=False, indent=2) + "\n",
                                          encoding="utf-8")
    icon(FOLDER / "icon.png")
    return FOLDER


def package() -> Path:
    uv = shutil.which("uv") or str(ROOT / ".venv" / "Scripts" / "uv.exe")
    # uv.lock pins all the dependencies, transitive ones included.
    subprocess.run([uv, "lock", "--directory", str(FOLDER)], check=True)
    subprocess.run(["node", str(MCPB), "validate", str(FOLDER / "manifest.json")], check=True)
    bundle = BUILD / f"{NAME}-{awa_server.VERSION}.mcpb"
    subprocess.run(["node", str(MCPB), "pack", str(FOLDER), str(bundle)], check=True)
    return bundle


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--package", action="store_true", help="validate and package with mcpb (Node and uv)")
    args = parser.parse_args()
    folder = prepare()
    print(f"Extension prepared: {folder.relative_to(ROOT)}")
    if args.package:
        print(f"Package: {package().relative_to(ROOT)}")


if __name__ == "__main__":
    main()
