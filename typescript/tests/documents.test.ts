// Prepare images and PDFs, and foresee their cost in tokens, without a call to the API
// (python/tests/test_documents.py).

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { HIGH_RESOLUTION, STANDARD, documentBlock, expectedTokens, fileBlock, imageBlock, imageTokens, pdfBlock, seenSize } from "../comptoir/documents.ts";

// The table of Anthropic's Vision page (October 20, 2026): size seen and tokens.
const STANDARD_EXAMPLES: [[number, number], [number, number], number][] = [
  [[200, 200], [200, 200], 64],
  [[1000, 1000], [1000, 1000], 1296],
  [[1092, 1092], [1092, 1092], 1521],
  [[1920, 1080], [1456, 819], 1560],
  // The page's table gives 1269 × 952; the reference implementation of the same documentation gives
  // 1270 × 952. Same cost: 1564 tokens.
  [[2000, 1500], [1270, 952], 1564],
  [[3840, 2160], [1456, 819], 1560],
];
const HIGH_RESOLUTION_EXAMPLES: [[number, number], [number, number], number][] = [
  [[1920, 1080], [1920, 1080], 2691],
  [[2000, 1500], [2000, 1500], 3888],
  [[3840, 2160], [2576, 1449], 4784],
];

for (const [size, seen, tokens] of STANDARD_EXAMPLES) {
  test(`the standard level follows Anthropic's table: ${size.join(" × ")}`, () => {
    assert.deepEqual(seenSize(...size, ...STANDARD), seen);
    assert.equal(imageTokens(...seen), tokens);
  });
}

for (const [size, seen, tokens] of HIGH_RESOLUTION_EXAMPLES) {
  test(`high resolution follows Anthropic's table: ${size.join(" × ")}`, () => {
    assert.deepEqual(seenSize(...size, ...HIGH_RESOLUTION), seen);
    assert.equal(imageTokens(...seen), tokens);
  });
}

test("the example of the A4 page", () => {
  // An A4 page scanned at 130 dots per inch: shrunk at the standard level, not in high resolution.
  assert.deepEqual(seenSize(1075, 1520, ...STANDARD), [924, 1307]);
  assert.deepEqual(seenSize(1075, 1520, ...HIGH_RESOLUTION), [1075, 1520]);
});

test("a phone photo costs at most 4784 tokens with Sonnet 5.5", () => {
  assert.ok(expectedTokens(3000, 4000, "claude-sonnet-5-5") <= 4784);
});

async function photo(width = 3000, height = 4000, name = "photo.jpg"): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "comptoir-")), name);
  await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 180, b: 160 } } }).jpeg({ quality: 80 }).toFile(path);
  return path;
}

test("an image block in base64", async () => {
  const block = await imageBlock(await photo());
  assert.equal(block.type, "image");
  assert.ok(block.source.type === "base64");
  assert.equal(block.source.media_type, "image/jpeg");
  assert.deepEqual([...Buffer.from(block.source.data, "base64").subarray(0, 2)], [0xff, 0xd8]); // start of a JPEG
});

test("shrink before sending", async () => {
  const block = await imageBlock(await photo(), 1000);
  assert.ok(block.source.type === "base64");
  const { width, height } = await sharp(Buffer.from(block.source.data, "base64")).metadata();
  assert.deepEqual([width, height], [750, 1000]);
});

test("a small image is never enlarged", async () => {
  const block = await imageBlock(await photo(400, 300), 1000);
  assert.ok(block.source.type === "base64");
  const { width, height } = await sharp(Buffer.from(block.source.data, "base64")).metadata();
  assert.deepEqual([width, height], [400, 300]);
});

test("a refused format", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "comptoir-")), "scan.tiff");
  writeFileSync(path, Buffer.from("II*\x00", "latin1"));
  await assert.rejects(imageBlock(path), /format not accepted/);
});

test("a PDF block with a title and citations", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "comptoir-")), "f.pdf");
  writeFileSync(path, "%PDF-1.4\n");
  const block = pdfBlock(path, "Invoice", true);
  assert.ok(block.source.type === "base64");
  assert.equal(block.source.media_type, "application/pdf");
  assert.equal(block.title, "Invoice");
  assert.deepEqual(block.citations, { enabled: true });
  assert.equal((await documentBlock(path)).type, "document");
});

test("a file of the Files API", () => {
  assert.deepEqual(fileBlock("file_abc", "document", true), {
    type: "document",
    source: { type: "file", file_id: "file_abc" },
    citations: { enabled: true },
  });
});
