// Awa's knowledge base: Markdown documents, split into citable sections (chapter 11).
//
// Each section becomes a “chunk” with a stable ID, for example kb://faq#are-you-open-on-sundays. These IDs
// come back in the citations: you know where each statement comes from, and the test checks it.
//
// The same base serves two uses: whole in the context, cached; or in chunks chosen by a search, when it
// becomes too big. The documents are those of the Python version (python/comptoir/knowledge/), read in
// place.

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PYTHON } from "./launch.ts";

export const FOLDER = join(PYTHON, "comptoir", "knowledge");
export const MAX_SIZE = 1200; // characters per chunk; beyond that, a section is cut between two paragraphs

export interface Chunk {
  id: string; //        kb://<document>#<section>, stable as long as the title does not change
  document: string; //  the file's name, without extension
  title: string; //     “Frequently asked questions — Are you open on Sundays?”
  text: string;
  context: string; //   a sentence that situates the chunk in its document (Contextual Retrieval)
}

/** What the indexes read: the context if it exists, the title, then the text. */
export const forRetrieval = (c: Chunk): string => [c.context, c.title, c.text].filter(Boolean).join(" ");

/** “Are you open on Sundays?” -> “are-you-open-on-sundays”. */
export function anchor(title: string): string {
  const withoutAccents = title.normalize("NFD").replace(/[^\x00-\x7f]/g, "");
  return withoutAccents.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const paragraphs = (text: string): string[] => text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/**
 * One “##” section per chunk. A section that is too long is cut between two paragraphs, and each part
 * takes up the last paragraph of the previous one: a sentence cut off from its context is badly retrieved.
 */
export function split(markdown: string, document: string, maxSize = MAX_SIZE): Chunk[] {
  const text = markdown.replace(/\r\n/g, "\n");
  const documentTitle = /^# (.+)$/m.exec(text)![1]!.trim();
  const chunks: Chunk[] = [];
  for (const section of text.split(/^## /m).slice(1)) {
    const end = section.indexOf("\n");
    const title = (end < 0 ? section : section.slice(0, end)).trim();
    const body = end < 0 ? "" : section.slice(end + 1);
    const parts: string[][] = [];
    let current: string[] = [];
    for (const p of paragraphs(body)) {
      if (current.length && [...current, p].join("\n\n").length > maxSize) {
        parts.push(current);
        current = [current.at(-1)!]; // overlap of one paragraph
      }
      current.push(p);
    }
    if (current.length) parts.push(current);
    parts.forEach((part, i) => {
      const suffix = parts.length > 1 ? `-${i + 1}` : "";
      chunks.push({
        id: `kb://${document}#${anchor(title)}${suffix}`,
        document,
        title: `${documentTitle} — ${title}`,
        text: part.join("\n\n"),
        context: "",
      });
    });
  }
  return chunks;
}

/**
 * All the chunks, in a stable order: that of the file names, then of the sections. The order matters:
 * the cache requires an identical beginning of request, byte for byte.
 */
export function loadKnowledge(folder = FOLDER): Chunk[] {
  const chunks = readdirSync(folder)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((f) => split(readFileSync(join(folder, f), "utf8"), f.slice(0, -3)));
  const ids = chunks.map((c) => c.id);
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].sort();
  if (duplicates.length) throw new Error(`Duplicate IDs in the knowledge base: ${duplicates.join(", ")}`);
  return chunks;
}

export function withContexts(chunks: Chunk[], contexts: Record<string, string>): Chunk[] {
  return chunks.map((c) => ({ ...c, context: contexts[c.id] ?? c.context }));
}

export type Cache = boolean | "5m" | "1h";

/** true or "5m": 5-minute cache; "1h": one-hour cache, written at twice the price. */
export function cacheControl(cache: Cache): Anthropic.CacheControlEphemeral | null {
  if (!cache) return null;
  return cache === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/** A chunk as a search_result block: Claude cites it with our source and our title. */
export function resultBlock(chunk: Chunk, cache: Cache = false, citations = true): Anthropic.SearchResultBlockParam {
  const block: Anthropic.SearchResultBlockParam = {
    type: "search_result",
    source: chunk.id,
    title: chunk.title,
    // One text block per paragraph: the paragraph is the smallest citable unit.
    content: paragraphs(chunk.text).map((p) => ({ type: "text", text: p })),
    citations: { enabled: citations },
  };
  const control = cacheControl(cache);
  if (control) block.cache_control = control;
  return block;
}

/**
 * The chunks as search_result blocks. With a cache, the breakpoint is set on the last one: everything
 * before it, tools and system prompt included, is cached together.
 */
export function resultBlocks(chunks: Chunk[], cache: Cache = false, citations = true): Anthropic.SearchResultBlockParam[] {
  const blocks = chunks.map((c) => resultBlock(c, false, citations));
  const control = cacheControl(cache);
  if (blocks.length && control) blocks.at(-1)!.cache_control = control;
  return blocks;
}
