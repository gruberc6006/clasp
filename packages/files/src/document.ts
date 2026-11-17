import { isJsonObject, stableStringify, type JsonValue } from "@clasp/core";
import type { FeatureBuilder, FeatureExtension, FeatureSpec } from "@clasp/features";
import type { ComponentContext, ComponentDefinition } from "@clasp/runtime";
import { DOCUMENT_KINDS, FILE_SERVICE_ID } from "./service";

interface OpenedFile {
  fileId: string;
  name: string;
  content: JsonValue;
}

function asOpened(value: JsonValue | undefined): OpenedFile | undefined {
  if (!isJsonObject(value) || typeof value.fileId !== "string") return undefined;
  return { fileId: value.fileId, name: typeof value.name === "string" ? value.name : "Untitled", content: value.content ?? null };
}

/**
 * Holds the document an editor works on, and saves it as a workspace file.
 *
 * Every file comes from the user: Open and Save As show a dialog, and the
 * file chosen there is the only one this application may use. The editor's
 * value flows into `content`; `loaded` hands the editor a document to show.
 */
export const documentComponent: ComponentDefinition = {
  type: "data.document",
  version: 1,
  category: "data",
  title: "Document",
  description:
    'The document an editor is working on, saved as a file in the workspace. Connect the editor\'s "value" to "content", and "loaded" to the editor\'s "set". New / Open / Save / Save As use file dialogs: the user picks every file. "title" is the file name, marked when there are unsaved edits.',
  properties: [
    { name: "kind", type: "enum", options: [...DOCUMENT_KINDS, "any"], default: "text", title: "Kind of document" },
    { name: "untitled", type: "string", default: "Untitled", title: "Name of a new document" },
    { name: "reopen", type: "boolean", default: true, title: "Reopen the last file on start" },
  ],
  inputs: [{ name: "content", type: "any", description: "The editor's current document." }],
  outputs: [
    { name: "name", type: "string" },
    { name: "title", type: "string", description: "The name, followed by “— Edited” while there are unsaved changes." },
    { name: "dirty", type: "boolean", description: "True while there are unsaved changes." },
    { name: "fileId", type: "string" },
  ],
  events: [
    { name: "loaded", payload: "any", description: "A document was opened or started; payload is its content (null for a new one)." },
    { name: "saved", payload: "object" },
    { name: "failed", payload: "object" },
  ],
  actions: [
    { name: "new", description: "Starts an empty document." },
    { name: "open", description: "Asks the user to pick a file." },
    { name: "save", description: "Saves to the current file, or asks for a name the first time." },
    { name: "saveAs", description: "Asks the user for a name and saves a copy." },
    { name: "openFile", payload: "object", description: "Opens a file this application was given. Payload: { fileId }." },
  ],
  capabilities: [{ capability: "storage.access", description: "Opens and saves only the files the user picks in file dialogs." }],
  create: (ctx: ComponentContext) => {
    const kind = (): string => (typeof ctx.props.kind === "string" ? ctx.props.kind : "text");
    const slot = ctx.object.id;
    const fingerprint = (value: JsonValue | undefined): string => stableStringify(value ?? null);

    const publish = (): void => {
      const name = ctx.getState<string>("name") ?? (typeof ctx.props.untitled === "string" ? ctx.props.untitled : "Untitled");
      const baseline = ctx.getState<string>("baseline");
      const content = ctx.input("content");
      const dirty = baseline !== undefined ? fingerprint(content) !== baseline : content !== undefined && content !== null && content !== "";
      ctx.setOutput("name", name);
      ctx.setOutput("dirty", dirty);
      ctx.setOutput("title", dirty ? `${name} — Edited` : name);
      ctx.setOutput("fileId", ctx.getState<string>("fileId"));
    };

    /** Records the editor's current content as "saved" once it has caught up with a load. */
    const settle = async (): Promise<void> => {
      // Let the editor receive and normalize the loaded document first.
      await Promise.resolve();
      if (!ctx.alive) return;
      ctx.setState("baseline", fingerprint(ctx.input("content")));
      publish();
    };

    const failed = (error: { code: string; message: string }): void => {
      ctx.emit("failed", { code: error.code, message: error.message });
      ctx.fail(error);
    };

    const load = async (file: OpenedFile | undefined): Promise<void> => {
      await Promise.resolve(); // leave the current scheduler pass so the load propagates now
      if (!ctx.alive) return;
      ctx.setState("fileId", file?.fileId);
      ctx.setState("name", file?.name);
      ctx.emit("loaded", file ? file.content : null);
      await settle();
    };

    const saveAs = (): void => {
      ctx.run(
        async () => {
          const content = ctx.input("content") ?? null;
          const result = asOpened(
            (await ctx.clasp.invoke({
              target: FILE_SERVICE_ID,
              action: "saveAs",
              arguments: { kind: kind(), slot, name: ctx.getState<string>("name") ?? (ctx.props.untitled as string) ?? "Untitled", content },
            })) ?? undefined,
          );
          if (!result || !ctx.alive) return; // cancelled
          ctx.setState("fileId", result.fileId);
          ctx.setState("name", result.name);
          ctx.setState("baseline", fingerprint(content));
          publish();
          ctx.emit("saved", { fileId: result.fileId, name: result.name });
        },
        // A save in progress (dialog included) is work, so "idle" means "saved".
        failed,
      );
    };

    publish();
    return {
      start: () => {
        ctx.run(
          async () => {
            const recent =
              ctx.props.reopen === false
                ? undefined
                : asOpened((await ctx.clasp.invoke({ target: FILE_SERVICE_ID, action: "recent", arguments: { kind: kind(), slot } })) ?? undefined);
            // Otherwise the editor's empty document is the starting point: nothing is unsaved yet.
            if (recent && ctx.alive) await load(recent);
            else await settle();
          },
          // Reopening is a convenience; failing to do so is not worth an error.
          () => void settle(),
        );
      },
      onInput: publish,
      actions: {
        new: () => ctx.run(() => load(undefined), failed),
        open: () =>
          ctx.run(
            async () => {
              const opened = asOpened((await ctx.clasp.invoke({ target: FILE_SERVICE_ID, action: "open", arguments: { kind: kind(), slot } })) ?? undefined);
              if (opened && ctx.alive) await load(opened);
            },
            failed,
          ),
        save: () => {
          const fileId = ctx.getState<string>("fileId");
          if (!fileId) {
            saveAs();
            return;
          }
          ctx.run(async () => {
            const content = ctx.input("content") ?? null;
            await ctx.clasp.invoke({ target: FILE_SERVICE_ID, action: "save", arguments: { fileId, content, slot } });
            if (!ctx.alive) return;
            ctx.setState("baseline", fingerprint(content));
            publish();
            ctx.emit("saved", { fileId, name: ctx.getState<string>("name") ?? "" });
          }, failed);
        },
        saveAs,
        openFile: (payload) => {
          const fileId = isJsonObject(payload) && typeof payload.fileId === "string" ? payload.fileId : typeof payload === "string" ? payload : undefined;
          if (!fileId) return;
          ctx.run(async () => {
            const opened = asOpened((await ctx.clasp.invoke({ target: FILE_SERVICE_ID, action: "read", arguments: { fileId, slot } })) ?? undefined);
            if (opened && ctx.alive) await load(opened);
          }, failed);
        },
      },
    };
  },
};

const EDITORS: Record<string, { type: string; title: string; width: "regular" | "wide"; properties: Record<string, JsonValue>; noun: string; kind?: string }> = {
  text: { type: "ui.textInput", title: "Text", width: "regular", properties: { multiline: true, rows: 18, placeholder: "Start writing…" }, noun: "text editor" },
  richtext: { type: "ui.richText", title: "Page", width: "wide", properties: {}, noun: "word processor (headings, bold, italic, lists)" },
  code: { type: "ui.codeEditor", title: "Editor", width: "wide", properties: {}, noun: "code editor with line numbers", kind: "text" },
  spreadsheet: { type: "ui.spreadsheet", title: "Sheet", width: "wide", properties: {}, noun: "spreadsheet with formulas" },
  drawing: { type: "ui.canvas", title: "Canvas", width: "wide", properties: {}, noun: "drawing canvas" },
  sequencer: { type: "ui.sequencer", title: "Sequencer", width: "wide", properties: {}, noun: "step sequencer that plays music" },
};

/**
 * The `document` feature: an editor in the window, plus — with `files` — a
 * document, a New / Open / Save / Save As toolbar, and the file name as the
 * window title.
 */
export const documentFeature: FeatureExtension = {
  kind: "document",
  compile(feature: FeatureSpec, builder: FeatureBuilder): void {
    if (feature.kind !== "document") return;
    const editor = EDITORS[feature.editor];
    if (!editor) {
      builder.issues.push(`Unknown editor "${String(feature.editor)}". Use one of: ${Object.keys(EDITORS).join(", ")}.`);
      return;
    }
    const windowId = builder.window(editor.width);
    const withFiles = feature.files !== false;
    let documentId: string | undefined;
    if (withFiles) {
      const toolbar = builder.create("ui.container", "File toolbar", { direction: "row", gap: "small", align: "center" }, builder.place("top"));
      documentId = builder.create("data.document", feature.name ?? "Document", { kind: editor.kind ?? feature.editor, untitled: feature.title ?? "Untitled" });
      const buttons: Array<[string, string, string]> = [
        ["New", "new", "ghost"],
        ["Open…", "open", "secondary"],
        ["Save", "save", "primary"],
        ["Save As…", "saveAs", "ghost"],
      ];
      buttons.forEach(([label, action, variant], index) => {
        const button = builder.create("ui.button", `${label.replace("…", "")} button`, { label, variant }, { parentId: toolbar, order: index });
        builder.connect(`${button}.click`, `${documentId}.${action}`);
      });
      if (!builder.inputTaken(windowId, "title")) builder.connect(`${documentId}.title`, `${windowId}.title`);
    }
    const editorId = builder.create(editor.type, editor.title, editor.properties, builder.place("content"));
    if (documentId) {
      builder.connect(`${editorId}.value`, `${documentId}.content`);
      builder.connect(`${documentId}.loaded`, `${editorId}.set`);
    }
    builder.described.push(`A ${editor.noun}${withFiles ? " that opens and saves files (New, Open, Save, Save As)" : ""}`);
  },
};
