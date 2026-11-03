// Chapter 10: the same report, as an Excel workbook, with Anthropic's “xlsx” Skill.
//
// A Skill is a folder of instructions and scripts that Claude loads into the container when it needs it.
// Anthropic's Skills (xlsx, pptx, docx, pdf) are added through the container parameter, with the code
// execution tool.
//
// Run, from the typescript/ folder:  npx tsx ch10/excel_report.ts

import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { config } from "../comptoir/config.ts";
import { PYTHON, isMain } from "../comptoir/launch.ts";
import { CODE_EXECUTION, call, producedFiles, toolErrors } from "../comptoir/server_tools.ts";

const SALES = join(PYTHON, "ch10", "data", "sales-2026-10-12.csv");
const OUTPUT = join("reports", "week-2026-10-12");

const INSTRUCTION = `Here is the export of the sales of Délices d'Awa for the week of October 12 to 18, 2026 (CSV).
Produce weekly-sales.xlsx, in English, with three sheets: “Sales” (the raw data),
“By product” (quantities and amounts calculated by Excel formulas from the Sales sheet)
and “By day” (amounts per date, by formulas). Format the amounts as numbers without decimals.
Copy the file into $OUTPUT_DIR and list that folder in the same command.`;

/** A file of a zip archive, read through its central directory. Enough for an .xlsx (neither ZIP64 nor encryption). */
export function readFromZip(archive: Buffer, name: string): Buffer {
  const start = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); // end of the central directory
  if (start < 0) throw new Error("This file is not a zip archive.");
  const entries = archive.readUInt16LE(start + 10);
  let position = archive.readUInt32LE(start + 16);
  for (let n = 0; n < entries; n++) {
    const method = archive.readUInt16LE(position + 10);
    const size = archive.readUInt32LE(position + 20);
    const nameLength = archive.readUInt16LE(position + 28);
    const rest = nameLength + archive.readUInt16LE(position + 30) + archive.readUInt16LE(position + 32);
    const local = archive.readUInt32LE(position + 42);
    if (archive.toString("utf8", position + 46, position + 46 + nameLength) === name) {
      const data = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
      const raw = archive.subarray(data, data + size);
      if (method === 0) return raw; //                  stored as is
      if (method === 8) return inflateRawSync(raw); //  compressed (deflate)
      throw new Error(`Compression method ${method} not supported.`);
    }
    position += 46 + rest;
  }
  throw new Error(`“${name}” is not in the archive.`);
}

/** The names of the sheets of an .xlsx, read without a library: it is a zip archive. */
export function sheets(workbook: string): string[] {
  const content = readFromZip(readFileSync(workbook), "xl/workbook.xml").toString("utf8");
  return content.split('<sheet name="').slice(1).map((piece) => piece.split('"')[0]!);
}

async function main(): Promise<void> {
  const client = new Anthropic();
  const sent = await client.files.upload({ file: await toFile(readFileSync(SALES), basename(SALES), { type: "text/csv" }) });
  const produced: string[] = [];
  try {
    const result = await call(client, {
      model: config.MODEL,
      max_tokens: 16000,
      tools: [CODE_EXECUTION],
      container: { skills: [{ type: "anthropic", skill_id: "xlsx", version: "latest" }] },
      messages: [{ role: "user", content: [{ type: "container_upload", file_id: sent.id }, { type: "text", text: INSTRUCTION }] }],
    });
    console.log(result.text);
    for (const error of toolErrors(result.message)) console.log(`  ⚠ ${error}`);
    mkdirSync(OUTPUT, { recursive: true });
    for (const message of result.messages) produced.push(...producedFiles(message));
    for (const id of produced) {
      const name = (await client.files.retrieveMetadata(id)).filename;
      const response = await client.files.download(id);
      writeFileSync(join(OUTPUT, name), Buffer.from(await response.arrayBuffer()));
      const detail = name.endsWith(".xlsx") ? ` — sheets: ${JSON.stringify(sheets(join(OUTPUT, name)))}` : "";
      console.log(`  file received: ${join(OUTPUT, name)}${detail}`);
    }
    const usage = result.message.usage;
    console.log(
      `\n${result.calls} call(s); last call: input ${usage.input_tokens} tokens, output ${usage.output_tokens}; ` +
        `cost in tokens $${result.cost.toFixed(4)}`,
    );
  } finally {
    for (const id of [sent.id, ...produced]) await client.files.delete(id);
    console.log("Files deleted from the Files API.");
  }
}

if (isMain(import.meta.url)) await main();
