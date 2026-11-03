// What is used to run the chapters' scripts: where the files are, and whether a module is the program
// being run or an imported module (by the tests).

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository's typescript/ folder. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The python/ folder, next to it. The data common to both languages (evaluation cases, catalog,
 * prompts) is read there in place: a single source, which both versions of the Comptoir share.
 */
export const PYTHON = join(ROOT, "..", "python");

/** True if this module is the script being run (`npx tsx ch02/comptoir_cli.ts`), false if it is imported. */
export function isMain(moduleUrl: string): boolean {
  const launched = process.argv[1];
  if (!launched) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(launched);
  } catch {
    return false;
  }
}

/**
 * The command-line arguments, where an option with several values (nargs="+" in Python) takes all the
 * words that follow it: “--modes context rag” becomes “--modes context --modes rag”, the form parseArgs
 * reads (option `multiple: true`). Such an option left without a value (nargs="*": “--traces” alone,
 * for an empty list) becomes “--traces=”: an empty value, which the script discards.
 */
export function multipleValues(options: string[], args = process.argv.slice(2)): string[] {
  const out: string[] = [];
  let open: string | null = null;
  let values = 0;
  const close = (): void => {
    if (open && !values) out[out.length - 1] = `${open}=`;
  };
  for (const word of args) {
    if (word.startsWith("-")) {
      close();
      open = options.includes(word.replace(/^--?/, "")) ? word : null;
      values = 0;
      out.push(word);
    } else {
      if (open && values) out.push(open);
      if (open) values++;
      out.push(word);
    }
  }
  close();
  return out;
}
