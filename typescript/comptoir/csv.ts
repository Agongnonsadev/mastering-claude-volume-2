// Read and write the results files (results/trials.csv) in the format of Python's csv module: the
// files of both versions are interchangeable. A boolean is written True or False, a missing value stays
// empty, and a field takes quotes only if it contains a comma, a quote or a line break. A column declared
// “float” is written like a Python float: 0.0, 5.72, 1e-05.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { floatText } from "./python.ts";

const field = (value: unknown): string => {
  const text = value === null || value === undefined ? "" : typeof value === "boolean" ? (value ? "True" : "False") : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export { floatText };

/** floats: the columns that are floats in the Python version (costs, durations). */
export function writeCsv<T extends object>(lines: T[], columns: (keyof T & string)[], path: string, floats: (keyof T & string)[] = []): void {
  mkdirSync(dirname(path), { recursive: true });
  const value = (l: T, c: keyof T & string): unknown => (floats.includes(c) && typeof l[c] === "number" ? floatText(l[c]) : l[c]);
  const text = [columns.join(","), ...lines.map((l) => columns.map((c) => field(value(l, c))).join(","))];
  writeFileSync(path, text.join("\r\n") + "\r\n", "utf8");
}

/** The lines of a CSV file, each as an object { column: text }. */
export function readCsv(path: string): Record<string, string>[] {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  const lines: string[][] = [];
  let line: string[] = [];
  let value = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        value += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      line.push(value);
      value = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      line.push(value);
      lines.push(line);
      line = [];
      value = "";
    } else {
      value += c;
    }
  }
  if (value || line.length) lines.push([...line, value]);
  const [header, ...data] = lines;
  if (!header) return [];
  return data.map((l) => Object.fromEntries(header.map((name, i) => [name, l[i] ?? ""])));
}
