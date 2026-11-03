// The Comptoir's system prompt: a versioned file, filled in by the code (chapter 5).
//
// The instructions live in python/comptoir/prompts/system_vN.md; the data (catalog, terms) in
// python/comptoir/data/delices_awa.json. Both versions of the Comptoir read the same files, and the code
// assembles the two: a price is written in one place only.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PYTHON } from "./launch.ts";

const FOLDER = join(PYTHON, "comptoir");
export const DEFAULT_VERSION = "v1";

export class SystemPrompt {
  constructor(
    readonly text: string,
    readonly version: string,
  ) {}

  /** 8 characters that change as soon as a single character of the prompt changes. */
  get fingerprint(): string {
    return createHash("sha256").update(this.text, "utf8").digest("hex").slice(0, 8);
  }

  get id(): string {
    return `system-${this.version}@${this.fingerprint}`;
  }
}

export interface Data {
  products: { name: string; format: string; price_fcfa: number }[];
  terms: string[];
}

export function loadData(path = join(FOLDER, "data", "delices_awa.json")): Data {
  return JSON.parse(readFileSync(path, "utf8")) as Data;
}

/** 1000 -> “1,000 FCFA”. */
const fcfa = (amount: number): string => `${amount.toLocaleString("en-US")} FCFA`;

export function renderCatalog(data: Data): string {
  return data.products.map((p) => `- ${p.name}: ${fcfa(p.price_fcfa)} per ${p.format}`).join("\n");
}

export function renderTerms(data: Data): string {
  return data.terms.map((t) => `- ${t}`).join("\n");
}

/**
 * Replaces $name and ${name} with their value, $$ with $, like string.Template.substitute in Python: a
 * placeholder without a value is an error, not a hole in the prompt.
 */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\$(?:(\$)|([_a-z][_a-z0-9]*)|\{([_a-z][_a-z0-9]*)\}|)/gi, (all, dollar, name, nameInBraces) => {
    if (dollar) return "$";
    const key = name ?? nameInBraces;
    if (key === undefined) throw new Error(`Invalid placeholder in the prompt: '${all}'`);
    const value = values[key];
    if (value === undefined) throw new Error(`No value for the placeholder '$${key}' of the prompt.`);
    return value;
  });
}

export function load(version = DEFAULT_VERSION, data?: Data): SystemPrompt {
  const template = readFileSync(join(FOLDER, "prompts", `system_${version}.md`), "utf8").replace(/\r\n/g, "\n");
  const d = data ?? loadData();
  const text = fill(template, { catalog: renderCatalog(d), terms: renderTerms(d) });
  return new SystemPrompt(text.trim(), version);
}

// --- The customer's message: data, never an instruction -----------------------

export const MAX_LENGTH = 2000;
const TAG = /<\s*\/?\s*customer_message\s*>/gi;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Removes what could make the customer's text break out of its tag, and caps it. */
export function sanitize(text: string, maxLength = MAX_LENGTH): string {
  const clean = text.replace(CONTROL, "").replace(TAG, "").trim();
  // Counted in characters, as in Python, not in UTF-16 units: an emoji is never cut.
  return [...clean].slice(0, maxLength).join("");
}

export function customerMessage(text: string): string {
  return `<customer_message>\n${sanitize(text)}\n</customer_message>`;
}
