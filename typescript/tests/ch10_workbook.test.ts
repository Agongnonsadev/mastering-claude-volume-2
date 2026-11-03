// The names of the sheets of an Excel workbook, read from its zip archive (ch10/excel_report.ts), and the
// same as those the Python version reads.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { readFromZip, sheets } from "../ch10/excel_report.ts";
import { PYTHON } from "../comptoir/launch.ts";

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?><workbook><sheets><sheet name="Sales" sheetId="1"/><sheet name="By product" sheetId="2"/><sheet name="By day" sheetId="3"/></sheets></workbook>`;

/** A minimal zip archive, written by hand: local headers, central directory, end of directory. */
function archive(files: { name: string; content: string; compressed: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let position = 0;
  for (const { name, content, compressed } of files) {
    const raw = Buffer.from(content, "utf8");
    const data = compressed ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(compressed ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(compressed ? 8 : 0, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(position, 42);
    locals.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    position += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(position, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("read a stored or compressed file in an archive", () => {
  const zip = archive([
    { name: "[Content_Types].xml", content: "<Types/>", compressed: false },
    { name: "xl/workbook.xml", content: WORKBOOK, compressed: true },
  ]);
  assert.equal(readFromZip(zip, "[Content_Types].xml").toString(), "<Types/>");
  assert.equal(readFromZip(zip, "xl/workbook.xml").toString(), WORKBOOK);
  assert.throws(() => readFromZip(zip, "xl/missing.xml"), /is not in the archive/);
  assert.throws(() => readFromZip(Buffer.from("not a zip"), "xl/workbook.xml"), /not a zip archive/);
});

test("the names of the sheets of a workbook", () => {
  const path = join(mkdtempSync(join(tmpdir(), "workbook-")), "sales.xlsx");
  writeFileSync(path, archive([{ name: "xl/workbook.xml", content: WORKBOOK, compressed: true }]));
  assert.deepEqual(sheets(path), ["Sales", "By product", "By day"]);
});

// --- The same sheets as the Python version ----------------------------------------------------

const PYTHON_VENV = [join(PYTHON, ".venv", "Scripts", "python.exe"), join(PYTHON, ".venv", "bin", "python")].find(existsSync);
// The workbook the xlsx Skill produced during the measurements of the Python version, if it is there
// (reports/ does not enter the repository).
const PRODUCED = join(PYTHON, "reports", "week-2026-10-12", "weekly-sales.xlsx");

test("the same sheets as the Python version, on zipfile archives", { skip: PYTHON_VENV ? false : "Python environment missing" }, () => {
  const folder = mkdtempSync(join(tmpdir(), "workbooks-"));
  const script = `
import json, sys, zipfile
from pathlib import Path
from ch10.excel_report import sheets
folder = Path(sys.argv[1])
workbook = sys.argv[2]
paths = []
for name, method in [("stored", zipfile.ZIP_STORED), ("compressed", zipfile.ZIP_DEFLATED)]:
    path = folder / f"{name}.xlsx"
    with zipfile.ZipFile(path, "w", method) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("xl/workbook.xml", workbook)
        archive.comment = b"made for the test"
    paths.append(str(path))
if Path(sys.argv[3]).exists():
    paths.append(sys.argv[3])
print(json.dumps({p: sheets(Path(p)) for p in paths}, ensure_ascii=False))`;
  const python = JSON.parse(
    execFileSync(PYTHON_VENV!, ["-c", script, folder, WORKBOOK.replace("By day", "By day &amp; neighborhood"), PRODUCED], {
      cwd: PYTHON,
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    }),
  ) as Record<string, string[]>;
  assert.ok(Object.keys(python).length >= 2);
  for (const [path, names] of Object.entries(python)) assert.deepEqual(sheets(path), names, path);
});
