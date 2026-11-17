import type { JsonObject } from "@clasp/core";

/**
 * A small Markdown reader producing a plain document tree. Renderers draw the
 * tree as elements; no HTML from a document is ever injected, so a document
 * cannot run code or style the Studio.
 */

export interface Span extends JsonObject {
  text: string;
}

export type Block =
  | { type: "heading"; level: number; spans: Span[] }
  | { type: "paragraph"; spans: Span[] }
  | { type: "list"; ordered: boolean; items: Span[][] }
  | { type: "quote"; spans: Span[] }
  | { type: "code"; text: string }
  | { type: "rule" };

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/** Splits a line into styled spans: **bold**, *italic* / _italic_, `code`, [text](https://link). */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  const pattern = /(\*\*([^*]+)\*\*)|(\*([^*\s][^*]*)\*)|(_([^_\s][^_]*)_)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) spans.push({ text: text.slice(last, match.index) });
    if (match[2] !== undefined) spans.push({ text: match[2], bold: true });
    else if (match[4] !== undefined) spans.push({ text: match[4], italic: true });
    else if (match[6] !== undefined) spans.push({ text: match[6], italic: true });
    else if (match[8] !== undefined) spans.push({ text: match[8], code: true });
    else if (match[10] !== undefined) {
      const href = match[11] as string;
      spans.push(SAFE_LINK.test(href) ? { text: match[10], href } : { text: match[10] });
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.length > 0 ? spans : [{ text: "" }];
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", spans: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      for (index++; index < lines.length && !/^```/.test(lines[index] as string); index++) code.push(lines[index] as string);
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: (heading[1] as string).length, spans: parseInline(heading[2] as string) });
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      blocks.push({ type: "quote", spans: parseInline(line.replace(/^>\s?/, "")) });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = Boolean(numbered);
      const previous = blocks[blocks.length - 1];
      const item = parseInline(((bullet ?? numbered) as RegExpExecArray)[1] as string);
      if (previous?.type === "list" && previous.ordered === ordered) previous.items.push(item);
      else blocks.push({ type: "list", ordered, items: [item] });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

export function countWords(text: string): number {
  const words = text.replace(/[#>*_`[\]()-]/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.length;
}
