import { ClaspError, Emitter, isJsonObject, nowIso, type JsonObject, type JsonValue } from "@clasp/core";
import type { SchemaRegistry } from "@clasp/schemas";
import { SYSTEM_PRINCIPAL, type ClaspKernel, type ClaspRecord } from "@clasp/universal-api";

/** Resource id of the workspace file service. */
export const FILE_SERVICE_ID = "clasp.files";
/** System-owned collection that holds file records. Applications never receive grants on it. */
export const FILE_STORE_ID = "clasp.files.store";

/** Kinds of document Clasp knows how to open. `any` matches every kind. */
export const DOCUMENT_KINDS = ["text", "richtext", "spreadsheet", "drawing", "sequencer"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const FILE_SCHEMA = {
  id: "clasp.file",
  version: 1,
  title: "File",
  description: "A document in the workspace's file store.",
  fields: {
    name: { type: "string" as const, required: true, minLength: 1, title: "Name" },
    kind: { type: "string" as const, required: true, title: "Kind" },
    content: { type: "json" as const, title: "Content" },
    size: { type: "number" as const, default: 0, title: "Size" },
    access: { type: "list" as const, items: "string" as const, default: [], title: "Applications with access" },
    lastUsedBy: { type: "json" as const, default: {}, title: "Last used, per application" },
  },
};

export interface FileEntry {
  id: string;
  name: string;
  kind: string;
  size: number;
  createdAt: string;
  updatedAt: string;
  /** Applications the user has let open or save this file. */
  access: string[];
}

export interface FileDialogRequest {
  /** The application asking. */
  appId: string;
  appName: string;
  kind: string;
}

/** What the user chose in a Save As dialog. */
export interface SaveChoice {
  name: string;
  /** Overwrite this existing file instead of creating a new one. */
  replace?: string;
}

/**
 * The host's file dialogs. Whatever the user picks here is the only thing
 * the asking application gets — this is how consent is given.
 */
export interface FileDialogs {
  open(request: FileDialogRequest): Promise<string | undefined>;
  save(request: FileDialogRequest & { suggestedName: string }): Promise<SaveChoice | undefined>;
}

export interface OpenedFile {
  fileId: string;
  name: string;
  kind: string;
  content: JsonValue;
}

function sizeOf(content: JsonValue | undefined): number {
  return content === undefined ? 0 : JSON.stringify(content).length;
}

function toEntry(record: ClaspRecord): FileEntry {
  return {
    id: record.id,
    name: String(record.fields.name),
    kind: String(record.fields.kind),
    size: typeof record.fields.size === "number" ? record.fields.size : 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    access: Array.isArray(record.fields.access) ? record.fields.access.filter((entry): entry is string => typeof entry === "string") : [],
  };
}

/**
 * The workspace file service.
 *
 * Files live in a system-owned collection that no application can query.
 * Applications reach files only through these service actions:
 *
 *   open   {kind}                   → the user picks a file in a dialog; the app gets that file
 *   saveAs {kind, name?, content}   → the user names the file in a dialog; the app gets that file
 *   save   {fileId, content}        → only for files the user gave this app before
 *   read   {fileId}                 → likewise
 *   recent {kind, slot?}            → the last file this app used for `slot`, if it still has access
 *
 * `open` and `saveAs` are user-mediated (the dialog is the consent), so they
 * need no grant; `save`, `read` and `recent` check the file's own access list.
 */
export class FileService {
  private dialogs: FileDialogs | undefined;
  private readonly changes = new Emitter<void>();

  constructor(
    private readonly kernel: ClaspKernel,
    schemas: SchemaRegistry,
    dialogs?: FileDialogs,
  ) {
    this.dialogs = dialogs;
    if (!schemas.has(FILE_SCHEMA.id, FILE_SCHEMA.version)) schemas.register(FILE_SCHEMA);
    kernel.addResources(SYSTEM_PRINCIPAL, [
      {
        id: FILE_STORE_ID,
        kind: "collection",
        name: "Files",
        description: "The workspace's documents. Applications open and save them through the file service; listing them needs your permission.",
        ownerId: SYSTEM_PRINCIPAL,
        // Discoverable so a file browser can ask to list files; reading still needs the user's grant.
        exposure: "discoverable",
        schema: { id: FILE_SCHEMA.id, version: FILE_SCHEMA.version },
      },
      {
        id: FILE_SERVICE_ID,
        kind: "service",
        name: "Files",
        description: "Open and save documents. The user chooses every file in a dialog.",
        ownerId: SYSTEM_PRINCIPAL,
        exposure: "discoverable",
        actions: [
          { name: "open", description: "Asks the user to pick a file. Arguments: { kind }. Returns { fileId, name, kind, content }." },
          { name: "saveAs", description: "Asks the user to name a file. Arguments: { kind, name?, content }. Returns { fileId, name }." },
          { name: "save", description: "Saves a file the user gave this application. Arguments: { fileId, content }." },
          { name: "read", description: "Reads a file the user gave this application. Arguments: { fileId }." },
          { name: "recent", description: "The last file this application used. Arguments: { kind, slot? }." },
        ],
        mediatedActions: ["open", "saveAs", "save", "read", "recent"],
      },
    ]);
    kernel.bindProvider(FILE_SERVICE_ID, { invoke: (action, args, caller) => this.handle(action, args, caller) });
    kernel.data.onChange(({ collectionId }) => {
      if (collectionId === FILE_STORE_ID) this.changes.emit();
    });
  }

  setDialogs(dialogs: FileDialogs | undefined): void {
    this.dialogs = dialogs;
  }

  // ── for the host (the user's own view of their files) ────────────────

  list(kind?: string): FileEntry[] {
    return this.kernel.data
      .list(FILE_STORE_ID)
      .map(toEntry)
      .filter((entry) => !kind || kind === "any" || entry.kind === kind)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.name.localeCompare(b.name)));
  }

  get(fileId: string): (FileEntry & { content: JsonValue }) | undefined {
    const record = this.kernel.data.get(FILE_STORE_ID, fileId);
    return record ? { ...toEntry(record), content: record.fields.content ?? null } : undefined;
  }

  /** Adds a file (e.g. imported from the computer's disk). No application gets access. */
  async create(name: string, kind: string, content: JsonValue): Promise<FileEntry> {
    const [change] = await this.kernel.data.apply(FILE_STORE_ID, [
      { operation: "create", data: { name: this.uniqueName(name.trim() || "Untitled"), kind, content, size: sizeOf(content), access: [], lastUsedBy: {} } },
    ]);
    return toEntry((change as { record: ClaspRecord }).record);
  }

  async rename(fileId: string, name: string): Promise<void> {
    if (!name.trim()) throw new ClaspError("VALIDATION_FAILED", "A file needs a name.");
    await this.kernel.data.apply(FILE_STORE_ID, [{ operation: "update", id: fileId, data: { name: name.trim() } }]);
  }

  async remove(fileId: string): Promise<void> {
    await this.kernel.data.apply(FILE_STORE_ID, [{ operation: "delete", id: fileId }]);
  }

  /** Lets one application open and save a file, as if the user had picked it for it in a dialog. Host only. */
  async allow(fileId: string, appId: string, slot = "default"): Promise<void> {
    const record = this.kernel.data.get(FILE_STORE_ID, fileId);
    if (!record) throw new ClaspError("NOT_FOUND", "That file no longer exists.");
    await this.touch(record, appId, slot);
  }

  /** Takes back every application's access to a file. */
  async revokeAccess(fileId: string): Promise<void> {
    await this.kernel.data.apply(FILE_STORE_ID, [{ operation: "update", id: fileId, data: { access: [], lastUsedBy: {} } }]);
  }

  subscribe(listener: () => void): () => void {
    return this.changes.subscribe(listener);
  }

  // ── for applications, through the Universal API ──────────────────────

  private async handle(action: string, args: JsonValue | undefined, caller: string): Promise<JsonValue> {
    const input: JsonObject = isJsonObject(args) ? args : {};
    const kind = typeof input.kind === "string" && input.kind ? input.kind : "any";
    const slot = typeof input.slot === "string" ? input.slot : "default";
    const appName = this.kernel.principalName(caller);
    switch (action) {
      case "open": {
        const dialogs = this.requireDialogs();
        const fileId = await dialogs.open({ appId: caller, appName, kind });
        if (!fileId) return null; // the user cancelled
        const record = this.kernel.data.get(FILE_STORE_ID, fileId);
        if (!record) throw new ClaspError("NOT_FOUND", "That file no longer exists.");
        if (kind !== "any" && record.fields.kind !== kind) {
          throw new ClaspError("INCOMPATIBLE", `“${String(record.fields.name)}” is a ${String(record.fields.kind)} file, not a ${kind} file.`);
        }
        await this.touch(record, caller, slot);
        return { fileId, name: String(record.fields.name), kind: String(record.fields.kind), content: record.fields.content ?? null };
      }
      case "saveAs": {
        const dialogs = this.requireDialogs();
        const suggestedName = typeof input.name === "string" && input.name.trim() ? input.name.trim() : "Untitled";
        const choice = await dialogs.save({ appId: caller, appName, kind, suggestedName });
        if (!choice) return null;
        const content = input.content ?? null;
        if (choice.replace) {
          const existing = this.kernel.data.get(FILE_STORE_ID, choice.replace);
          if (!existing) throw new ClaspError("NOT_FOUND", "The file to replace no longer exists.");
          await this.write(existing, caller, slot, { content, size: sizeOf(content), kind, name: choice.name.trim() || String(existing.fields.name) });
          return { fileId: existing.id, name: choice.name.trim() || String(existing.fields.name) };
        }
        const [change] = await this.kernel.data.apply(FILE_STORE_ID, [
          {
            operation: "create",
            data: { name: this.uniqueName(choice.name.trim() || suggestedName), kind, content, size: sizeOf(content), access: [caller], lastUsedBy: { [caller]: { [slot]: nowIso() } } },
          },
        ]);
        const record = (change as { record: ClaspRecord }).record;
        return { fileId: record.id, name: String(record.fields.name) };
      }
      case "save": {
        const record = this.accessible(input.fileId, caller);
        const content = input.content ?? null;
        await this.write(record, caller, slot, { content, size: sizeOf(content) });
        return { fileId: record.id, name: String(record.fields.name) };
      }
      case "read": {
        const record = this.accessible(input.fileId, caller);
        return { fileId: record.id, name: String(record.fields.name), kind: String(record.fields.kind), content: record.fields.content ?? null };
      }
      case "recent": {
        let best: { record: ClaspRecord; at: string } | undefined;
        for (const record of this.kernel.data.list(FILE_STORE_ID)) {
          if (kind !== "any" && record.fields.kind !== kind) continue;
          const access = record.fields.access;
          if (!Array.isArray(access) || !access.includes(caller)) continue;
          const used = isJsonObject(record.fields.lastUsedBy) ? record.fields.lastUsedBy[caller] : undefined;
          const at = isJsonObject(used) && typeof used[slot] === "string" ? (used[slot] as string) : undefined;
          if (at && (!best || at > best.at)) best = { record, at };
        }
        if (!best) return null;
        return { fileId: best.record.id, name: String(best.record.fields.name), kind: String(best.record.fields.kind), content: best.record.fields.content ?? null };
      }
      default:
        throw new ClaspError("NOT_FOUND", `Files has no action "${action}".`);
    }
  }

  private requireDialogs(): FileDialogs {
    if (!this.dialogs) throw new ClaspError("UNAVAILABLE", "This host cannot show file dialogs.");
    return this.dialogs;
  }

  /** A file this application was given by the user, or PERMISSION_DENIED. */
  private accessible(fileId: JsonValue | undefined, caller: string): ClaspRecord {
    if (typeof fileId !== "string") throw new ClaspError("VALIDATION_FAILED", "A fileId is required.");
    const record = this.kernel.data.get(FILE_STORE_ID, fileId);
    if (!record) throw new ClaspError("NOT_FOUND", "That file no longer exists.");
    const access = record.fields.access;
    if (!Array.isArray(access) || !access.includes(caller)) {
      throw new ClaspError("PERMISSION_DENIED", `“${this.kernel.principalName(caller)}” was not given “${String(record.fields.name)}”. Open it through a file dialog first.`);
    }
    return record;
  }

  private async touch(record: ClaspRecord, caller: string, slot: string): Promise<void> {
    await this.write(record, caller, slot, {});
  }

  private async write(record: ClaspRecord, caller: string, slot: string, fields: JsonObject): Promise<void> {
    const access = Array.isArray(record.fields.access) ? record.fields.access.filter((entry): entry is string => typeof entry === "string") : [];
    const used = isJsonObject(record.fields.lastUsedBy) ? { ...record.fields.lastUsedBy } : {};
    used[caller] = { ...(isJsonObject(used[caller]) ? used[caller] : {}), [slot]: nowIso() };
    await this.kernel.data.apply(FILE_STORE_ID, [
      { operation: "update", id: record.id, data: { ...fields, access: access.includes(caller) ? access : [...access, caller], lastUsedBy: used } },
    ]);
  }

  private uniqueName(name: string): string {
    const taken = new Set(this.kernel.data.list(FILE_STORE_ID).map((record) => String(record.fields.name)));
    if (!taken.has(name)) return name;
    for (let index = 2; ; index++) {
      const candidate = `${name} ${index}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}
