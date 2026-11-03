// The differences between two texts, like difflib.unified_diff in Python (chapters 10, 17, 18).
//
// The same algorithm as SequenceMatcher (without an isjunk function, with the default autojunk): the
// longest identical block first, then the same thing on the left and on the right. The output is thus
// Python's, line for line: “---” and “+++” headers, “@@ -1,5 +1,5 @@” blocks, n lines of context.

// The line endings that splitlines() recognizes in Python.
const END = "\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029";
const LINE = new RegExp(`[^${END}]*(?:\\r\\n|[${END}])|[^${END}]+$`, "g");
const LINE_END = new RegExp(`(?:\\r\\n|[${END}])$`);

/** The lines of a text, like text.splitlines(keepends) in Python: with or without their line endings. */
export function splitLines(text: string, keepEnds = false): string[] {
  const lines = text.match(LINE) ?? [];
  return keepEnds ? lines : lines.map((l) => l.replace(LINE_END, ""));
}

type Block = [number, number, number]; // start in a, start in b, length
type Code = ["equal" | "replace" | "delete" | "insert", number, number, number, number];

/** The identical blocks of a and b, in order, like SequenceMatcher(None, a, b).get_matching_blocks(). */
function matchingBlocks(a: string[], b: string[]): Block[] {
  const positions = new Map<string, number[]>();
  b.forEach((line, j) => {
    const list = positions.get(line);
    if (list) list.push(j);
    else positions.set(line, [j]);
  });
  // The autojunk: beyond 200 lines, a line that is too frequent (more than 1%) does not serve as an anchor.
  if (b.length >= 200) {
    const threshold = Math.floor(b.length / 100) + 1;
    for (const [line, list] of positions) if (list.length > threshold) positions.delete(line);
  }

  const longest = (alo: number, ahi: number, blo: number, bhi: number): Block => {
    let [bi, bj, size] = [alo, blo, 0];
    let lengths = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of positions.get(a[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (lengths.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > size) [bi, bj, size] = [i - k + 1, j - k + 1, k];
      }
      lengths = next;
    }
    while (bi > alo && bj > blo && a[bi - 1] === b[bj - 1]) [bi, bj, size] = [bi - 1, bj - 1, size + 1];
    while (bi + size < ahi && bj + size < bhi && a[bi + size] === b[bj + size]) size++;
    return [bi, bj, size];
  };

  const found: Block[] = [];
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (!k) continue;
    found.push([i, j, k]);
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  found.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  // Two blocks that touch make only one.
  const blocks: Block[] = [];
  let [i1, j1, k1] = [0, 0, 0];
  for (const [i2, j2, k2] of found) {
    if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
    else {
      if (k1) blocks.push([i1, j1, k1]);
      [i1, j1, k1] = [i2, j2, k2];
    }
  }
  if (k1) blocks.push([i1, j1, k1]);
  blocks.push([a.length, b.length, 0]);
  return blocks;
}

/** The operations that change a into b, like get_opcodes(). */
function operations(a: string[], b: string[]): Code[] {
  const codes: Code[] = [];
  let [i, j] = [0, 0];
  for (const [ai, bj, size] of matchingBlocks(a, b)) {
    if (i < ai && j < bj) codes.push(["replace", i, ai, j, bj]);
    else if (i < ai) codes.push(["delete", i, ai, j, bj]);
    else if (j < bj) codes.push(["insert", i, ai, j, bj]);
    [i, j] = [ai + size, bj + size];
    if (size) codes.push(["equal", ai, i, bj, j]);
  }
  return codes;
}

/** The operations grouped in blocks, with n lines of context, like get_grouped_opcodes(n). */
function* groups(a: string[], b: string[], n: number): Generator<Code[]> {
  const codes = operations(a, b);
  if (!codes.length) codes.push(["equal", 0, 1, 0, 1]);
  const first = codes[0]!;
  if (first[0] === "equal") codes[0] = ["equal", Math.max(first[1], first[2] - n), first[2], Math.max(first[3], first[4] - n), first[4]];
  const last = codes.at(-1)!;
  if (last[0] === "equal") codes[codes.length - 1] = ["equal", last[1], Math.min(last[2], last[1] + n), last[3], Math.min(last[4], last[3] + n)];
  let group: Code[] = [];
  for (const code of codes) {
    let [type, i1, i2, j1, j2] = code;
    // A long passage without change ends the current group.
    if (type === "equal" && i2 - i1 > 2 * n) {
      group.push([type, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
      yield group;
      group = [];
      [i1, j1] = [Math.max(i1, i2 - n), Math.max(j1, j2 - n)];
    }
    group.push([type, i1, i2, j1, j2]);
  }
  if (group.length && !(group.length === 1 && group[0]![0] === "equal")) yield group;
}

function range(start: number, stop: number): string {
  const length = stop - start;
  if (length === 1) return `${start + 1}`;
  return `${length ? start + 1 : start},${length}`;
}

/**
 * The lines of the unified diff from a to b, like difflib.unified_diff(a, b, fromfile, tofile, n=n,
 * lineterm=lineterm). The lines of a and b keep their line ending, if they have one.
 */
export function unifiedDiff(a: string[], b: string[], fromFile = "", toFile = "", { n = 3, lineterm = "\n" } = {}): string[] {
  const out: string[] = [];
  for (const group of groups(a, b, n)) {
    if (!out.length) out.push(`--- ${fromFile}${lineterm}`, `+++ ${toFile}${lineterm}`);
    const first = group[0]!;
    const last = group.at(-1)!;
    out.push(`@@ -${range(first[1], last[2])} +${range(first[3], last[4])} @@${lineterm}`);
    for (const [type, i1, i2, j1, j2] of group) {
      if (type === "equal") {
        for (const line of a.slice(i1, i2)) out.push(` ${line}`);
        continue;
      }
      if (type === "replace" || type === "delete") for (const line of a.slice(i1, i2)) out.push(`-${line}`);
      if (type === "replace" || type === "insert") for (const line of b.slice(j1, j2)) out.push(`+${line}`);
    }
  }
  return out;
}
