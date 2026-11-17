import { ClaspError, isJsonObject, type JsonValue } from "@clasp/core";

/** Format of a Clasp document saved on the computer's disk. */
const DISK_FORMAT = "clasp.file";

/** Splits one line of CSV, honouring quoted fields. */
function csvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index] as string;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      out.push(field);
      field = "";
    } else field += char;
  }
  out.push(field);
  return out;
}

function columnName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** Turns a file from disk into a workspace document: Clasp documents, plain text, or CSV (as a spreadsheet). */
export function importFile(fileName: string, text: string): { name: string; kind: string; content: JsonValue } {
  const base = fileName.replace(/\.clasp\.json$|\.[^.]+\.clasp\.json$/i, "").replace(/\.(txt|md|csv|json)$/i, "") || "Imported";
  if (/\.json$/i.test(fileName)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new ClaspError("VALIDATION_FAILED", "That file is not valid JSON.", { cause });
    }
    if (isJsonObject(parsed as JsonValue) && (parsed as { format?: unknown }).format === DISK_FORMAT) {
      const document = parsed as { name?: unknown; kind?: unknown; content?: JsonValue };
      if (typeof document.kind !== "string") throw new ClaspError("VALIDATION_FAILED", "The document does not say what kind it is.");
      return { name: typeof document.name === "string" ? document.name : base, kind: document.kind, content: document.content ?? null };
    }
    if ((parsed as { format?: unknown }).format === "clasp.package") {
      throw new ClaspError("INVALID_OPERATION", "That is an application package. Use + → Import package… to add applications.");
    }
    return { name: base, kind: "text", content: text };
  }
  if (/\.csv$/i.test(fileName)) {
    const cells: Record<string, string> = {};
    const lines = text.split(/\r?\n/).filter((line, index, all) => line !== "" || index < all.length - 1);
    let columns = 0;
    lines.forEach((line, row) => {
      const fields = csvLine(line);
      columns = Math.max(columns, fields.length);
      fields.forEach((value, column) => {
        if (value !== "") cells[`${columnName(column)}${row + 1}`] = value;
      });
    });
    return { name: base, kind: "spreadsheet", content: { rows: Math.max(30, lines.length + 5), columns: Math.max(10, columns), cells } };
  }
  // Markdown opens in the Word Processor.
  if (/\.(md|markdown)$/i.test(fileName)) return { name: base, kind: "richtext", content: text };
  return { name: base, kind: "text", content: text };
}

/** A copy of a workspace document for the computer's disk: text as .txt, Word Processor documents as .md, everything else as a Clasp document. */
export function exportFile(file: { name: string; kind: string; content: JsonValue }): { fileName: string; text: string; mimeType: string } {
  const safe = file.name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Untitled";
  if (file.kind === "text" && typeof file.content === "string") return { fileName: `${safe}.txt`, text: file.content, mimeType: "text/plain" };
  if (file.kind === "richtext" && typeof file.content === "string") return { fileName: `${safe}.md`, text: file.content, mimeType: "text/markdown" };
  return {
    fileName: `${safe}.${file.kind}.clasp.json`,
    text: JSON.stringify({ format: DISK_FORMAT, version: 1, name: file.name, kind: file.kind, content: file.content }, null, 2),
    mimeType: "application/json",
  };
}
