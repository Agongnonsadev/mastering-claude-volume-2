// Prepare an image or a PDF for Claude, and foresee what it will cost (chapter 7).
//
// Rules and limits read on October 20, 2026 on platform.claude.com (Vision, PDF support, Coordinates
// and bounding boxes). They change: check them (companion page).

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import sharp from "sharp";
import { round } from "./rounding.ts";

type ImageType = Anthropic.Base64ImageSource["media_type"];

export const IMAGE_TYPES: Record<string, ImageType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif", // only the first frame of an animation is read
  ".webp": "image/webp",
};

// Through Anthropic's API: 10 MB per image once encoded in base64 (5 MB on Bedrock and Google Cloud),
// 32 MB per request, 8000 px at most per side.
export const IMAGE_BASE64_MAX = 10 * 1024 * 1024;
export const MAX_REQUEST = 32 * 1024 * 1024;
export const ABSOLUTE_MAX_SIDE = 8000;

// Claude sees an image in squares of 28 × 28 pixels: one square, one token.
export const SQUARE = 28;

// Two resolution levels. The 4.7 and later models (all those of the Comptoir) are in high resolution:
// 2576 px per side and 4784 tokens at most. The others: 1568 and 1568.
export const HIGH_RESOLUTION: [maxSide: number, maxTokens: number] = [2576, 4784];
export const STANDARD: [maxSide: number, maxTokens: number] = [1568, 1568];
export const HIGH_RESOLUTION_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);

export function limits(model: string): [number, number] {
  return HIGH_RESOLUTION_MODELS.has(model) ? HIGH_RESOLUTION : STANDARD;
}

/** Tokens of an image of this size, if Claude sees it without shrinking it. */
export function imageTokens(width: number, height: number): number {
  return Math.ceil(width / SQUARE) * Math.ceil(height / SQUARE);
}

/**
 * The size to which Claude shrinks an image before reading it.
 *
 * Translation of Anthropic's reference implementation: the largest size, with the same proportions,
 * that respects both the maximum side and the number of tokens.
 */
export function seenSize(width: number, height: number, maxSide: number, maxTokens: number): [number, number] {
  const fits = (w: number, h: number): boolean =>
    Math.ceil(w / SQUARE) * SQUARE <= maxSide && Math.ceil(h / SQUARE) * SQUARE <= maxSide && imageTokens(w, h) <= maxTokens;

  if (fits(width, height)) return [width, height];
  if (height > width) {
    const [h, w] = seenSize(height, width, maxSide, maxTokens);
    return [w, h];
  }
  const ratio = width / height;
  let low = 1; // low always fits, high never
  let high = width;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle, Math.max(round(middle / ratio), 1))) low = middle;
    else high = middle;
  }
  return [low, Math.max(round(low / ratio), 1)];
}

/** Tokens the image will cost with this model, shrinking included. */
export function expectedTokens(width: number, height: number, model: string): number {
  return imageTokens(...seenSize(width, height, ...limits(model)));
}

export function imageType(path: string): ImageType {
  const type = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!type) throw new Error(`${basename(path)}: format not accepted (JPEG, PNG, GIF or WebP only).`);
  return type;
}

/**
 * Shrinks an image so that its long side does not exceed maxSide, as a good-quality JPEG.
 *
 * Shrinking before sending costs fewer tokens and lightens the request; shrinking too much makes the
 * writing illegible. Measure before choosing (step 6 of the chapter).
 */
export async function shrink(data: Buffer, maxSide: number): Promise<[Buffer, "image/jpeg"]> {
  const out = await sharp(data)
    .rotate() // puts the photo upright, according to its EXIF metadata
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  return [out, "image/jpeg"];
}

/** An image block in base64, ready for the API. */
export async function imageBlock(path: string, maxSide: number | null = null): Promise<Anthropic.ImageBlockParam> {
  let mediaType: ImageType = imageType(path);
  let data: Buffer = readFileSync(path);
  if (maxSide) [data, mediaType] = await shrink(data, maxSide);
  const encoded = data.toString("base64");
  if (encoded.length > IMAGE_BASE64_MAX) {
    throw new Error(`${basename(path)}: more than 10 MB once encoded; shrink it (maxSide).`);
  }
  return { type: "image", source: { type: "base64", media_type: mediaType, data: encoded } };
}

/** A PDF document block in base64. Claude reads the text of each page and its image. */
export function pdfBlock(path: string, title: string | null = null, citations = false): Anthropic.DocumentBlockParam {
  if (extname(path).toLowerCase() !== ".pdf") throw new Error(`${basename(path)}: a PDF is expected.`);
  const encoded = readFileSync(path).toString("base64");
  if (encoded.length > MAX_REQUEST) {
    throw new Error(`${basename(path)}: too heavy for a request; split it or go through the Files API.`);
  }
  const block: Anthropic.DocumentBlockParam = { type: "document", source: { type: "base64", media_type: "application/pdf", data: encoded } };
  if (title) block.title = title;
  if (citations) block.citations = { enabled: true };
  return block;
}

/** A block that designates a file already sent through the Files API (kind: document or image). */
export function fileBlock(fileId: string, kind: "document" | "image" = "document", citations = false): Anthropic.ContentBlockParam {
  if (kind === "image") return { type: "image", source: { type: "file", file_id: fileId } };
  const block: Anthropic.DocumentBlockParam = { type: "document", source: { type: "file", file_id: fileId } };
  if (citations) block.citations = { enabled: true };
  return block;
}

/** Image or PDF, according to the file's extension. */
export async function documentBlock(path: string, maxSide: number | null = null): Promise<Anthropic.ContentBlockParam> {
  return extname(path).toLowerCase() === ".pdf" ? pdfBlock(path) : imageBlock(path, maxSide);
}
