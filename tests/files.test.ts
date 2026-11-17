import { compileFeatures } from "@clasp/features";
import { DOCUMENT_APPS, buildFromFeatures, buildTaskManager } from "@clasp/examples";
import { FILE_SERVICE_ID, FILE_STORE_ID, documentFeature } from "@clasp/files";
import type { Workspace } from "@clasp/runtime";
import { describe, expect, it } from "vitest";
import { AppDriver, expectCode, openWorkspace } from "./support";

function template(id: string) {
  const entry = DOCUMENT_APPS.find((candidate) => candidate.id === id)!;
  return (workspace: Workspace) => buildFromFeatures(entry.name, entry.description, entry.plan, workspace.registry);
}

describe("Spreadsheet: a document app built from features", () => {
  it("computes formulas, saves through a dialog, tracks edits, and reopens its file", async () => {
    let session = await openWorkspace();
    let { workspace, dialogs, files } = session;
    const app = await workspace.install(template("spreadsheet")(workspace));
    let sheet = new AppDriver(workspace, app);
    await workspace.settle();
    expect(sheet.input("Window", "title")).toBe("Untitled sheet");

    const edits: Array<[string, string]> = [
      ["A1", "Rent"],
      ["B1", "1200"],
      ["A2", "Food"],
      ["B2", "450"],
      ["A3", "Total"],
      ["B3", "=SUM(B1:B2)"],
    ];
    for (const [cell, raw] of edits) await sheet.interact("Sheet", "edit", { cell, raw });
    expect((sheet.output("Sheet", "values") as Record<string, unknown>).B3).toBe(1650);
    expect(sheet.input("Window", "title")).toBe("Untitled sheet — Edited");

    // Save: the first time, the user names the file in a dialog.
    dialogs.saves.push({ name: "Budget" });
    await sheet.press("Save button");
    expect(dialogs.asked).toEqual([{ mode: "save", appName: "Spreadsheet", kind: "spreadsheet", suggestedName: "Untitled sheet" }]);
    expect(sheet.input("Window", "title")).toBe("Budget");
    const [file] = files.list();
    expect(file).toMatchObject({ name: "Budget", kind: "spreadsheet", access: [app.id] });

    // Later saves go straight to the same file, no dialog.
    await sheet.interact("Sheet", "edit", { cell: "B2", raw: "500" });
    expect(sheet.input("Window", "title")).toBe("Budget — Edited");
    await sheet.press("Save button");
    expect(dialogs.asked).toHaveLength(1);
    expect(sheet.input("Window", "title")).toBe("Budget");
    expect((files.get(file!.id)!.content as { cells: Record<string, string> }).cells.B2).toBe("500");

    // New starts an empty sheet; Open brings the file back.
    await sheet.press("New button");
    expect(sheet.output("Sheet", "values")).toEqual({});
    expect(sheet.input("Window", "title")).toBe("Untitled sheet");
    dialogs.opens.push(file!.id);
    await sheet.press("Open button");
    expect((sheet.output("Sheet", "values") as Record<string, unknown>).B3).toBe(1700);
    expect(sheet.input("Window", "title")).toBe("Budget");

    // After a reload the app reopens the file it was last working on.
    session = await session.reload();
    ({ workspace, dialogs, files } = session);
    sheet = new AppDriver(workspace, workspace.requireApp(app.id));
    await workspace.settle();
    expect(sheet.input("Window", "title")).toBe("Budget");
    expect((sheet.output("Sheet", "values") as Record<string, unknown>).B3).toBe(1700);
    await workspace.close();
  });

  it("changes nothing when the user cancels a dialog", async () => {
    const { workspace, dialogs, files } = await openWorkspace({ backend: "memory" });
    const sheet = new AppDriver(workspace, await workspace.install(template("spreadsheet")(workspace)));
    await workspace.settle();
    await sheet.interact("Sheet", "edit", { cell: "A1", raw: "kept" });
    dialogs.saves.push(undefined);
    await sheet.press("Save button");
    dialogs.opens.push(undefined);
    await sheet.press("Open button");
    expect(files.list()).toEqual([]);
    expect(sheet.input("Window", "title")).toBe("Untitled sheet — Edited");
    expect((sheet.output("Sheet", "value") as { cells: Record<string, string> }).cells.A1).toBe("kept");
  });
});

describe("files are reached only through the user's choices", () => {
  it("gives an application exactly the files the user picked for it", async () => {
    const { workspace, dialogs, files } = await openWorkspace({ backend: "memory" });
    const notes = new AppDriver(workspace, await workspace.install(template("notes")(workspace)));
    const other = await workspace.install(buildTaskManager(workspace.registry));
    await workspace.settle();

    await notes.type("Text", "Dear diary");
    dialogs.saves.push({ name: "Diary" });
    await notes.press("Save button");
    const [diary] = files.list();

    // Another application cannot list, read or overwrite it…
    await expectCode(other.clasp.query({ source: FILE_STORE_ID }), "PERMISSION_DENIED");
    // It may learn the file store exists (so a file browser can ask for it), but not what is in it.
    expect((await other.clasp.discover()).find((resource) => resource.id === FILE_STORE_ID)?.access).toEqual([]);
    await expectCode(other.clasp.invoke({ target: FILE_SERVICE_ID, action: "read", arguments: { fileId: diary!.id } }), "PERMISSION_DENIED");
    await expectCode(other.clasp.invoke({ target: FILE_SERVICE_ID, action: "save", arguments: { fileId: diary!.id, content: "hacked" } }), "PERMISSION_DENIED");
    expect(files.get(diary!.id)!.content).toBe("Dear diary");
    // …and asking for "recent" files reveals nothing it was not given.
    expect(await other.clasp.invoke({ target: FILE_SERVICE_ID, action: "recent", arguments: { kind: "any" } })).toBeUndefined();

    // Once the user picks the file for it in a dialog, it may use that file — and only that one.
    dialogs.opens.push(diary!.id);
    const opened = await other.clasp.invoke({ target: FILE_SERVICE_ID, action: "open", arguments: { kind: "text" } });
    expect(opened).toMatchObject({ fileId: diary!.id, name: "Diary", content: "Dear diary" });
    expect(dialogs.asked.at(-1)).toEqual({ mode: "open", appName: "Task Manager", kind: "text" });
    await other.clasp.invoke({ target: FILE_SERVICE_ID, action: "save", arguments: { fileId: diary!.id, content: "Dear diary, again" } });
    expect(files.get(diary!.id)).toMatchObject({ content: "Dear diary, again", access: [notes.app.id, other.id] });

    // The user can take that back.
    await files.revokeAccess(diary!.id);
    await expectCode(other.clasp.invoke({ target: FILE_SERVICE_ID, action: "read", arguments: { fileId: diary!.id } }), "PERMISSION_DENIED");
  });

  it("refuses to open a file as the wrong kind of document", async () => {
    const { workspace, dialogs, files } = await openWorkspace({ backend: "memory" });
    const drawing = await files.create("Doodle", "drawing", { strokes: [] });
    const sheet = new AppDriver(workspace, await workspace.install(template("spreadsheet")(workspace)));
    await workspace.settle();
    dialogs.opens.push(drawing.id);
    await sheet.press("Open button");
    expect(sheet.app.runtime.diagnostics().map((entry) => entry.message)).toContain("“Doodle” is a drawing file, not a spreadsheet file.");
    expect(files.get(drawing.id)!.access).toEqual([]);
  });

  it("keeps files across reloads and lets the user rename and delete them", async () => {
    let session = await openWorkspace();
    const created = await session.files.create("Shopping", "text", "eggs\nmilk");
    session = await session.reload();
    expect(session.files.list().map((file) => file.name)).toEqual(["Shopping"]);
    await session.files.rename(created.id, "Groceries");
    await session.files.create("Groceries", "text", "");
    expect(session.files.list().map((file) => file.name).sort()).toEqual(["Groceries", "Groceries 2"]);
    await session.files.remove(created.id);
    expect(session.files.list().map((file) => file.name)).toEqual(["Groceries 2"]);
    await session.workspace.close();
  });
});

describe("Sketchpad and Beat Maker", () => {
  it("draws, undoes and saves a drawing", async () => {
    const { workspace, dialogs, files } = await openWorkspace({ backend: "memory" });
    const pad = new AppDriver(workspace, await workspace.install(template("sketchpad")(workspace)));
    await workspace.settle();
    await pad.interact("Canvas", "stroke", { color: "#6c47ff", size: 6, points: [10, 10, 40, 60, 90, 80] });
    await pad.interact("Canvas", "stroke", { color: "#d92d20", size: 3, points: [5, 5, 6, 6] });
    expect(pad.output("Canvas", "strokes")).toBe(2);
    await pad.interact("Canvas", "undo");
    expect(pad.output("Canvas", "strokes")).toBe(1);
    dialogs.saves.push({ name: "Sketch" });
    await pad.press("Save button");
    const saved = files.get(files.list()[0]!.id)!.content as { strokes: Array<{ color: string; points: number[] }> };
    expect(saved.strokes).toEqual([{ color: "#6c47ff", size: 6, points: [10, 10, 40, 60, 90, 80] }]);
    await pad.press("New button");
    expect(pad.output("Canvas", "strokes")).toBe(0);
  });

  it("programs a beat, changes tempo, plays and saves the pattern", async () => {
    const { workspace, dialogs, files } = await openWorkspace({ backend: "memory" });
    const beat = new AppDriver(workspace, await workspace.install(template("beat-maker")(workspace)));
    await workspace.settle();
    const pattern = () => beat.output("Sequencer", "value") as { bpm: number; steps: number; tracks: Array<{ name: string; steps: boolean[] }> };
    expect(pattern().tracks.map((track) => track.name)).toEqual(["Kick", "Snare", "Hi-hat", "Clap", "Bass", "Chime"]);
    expect(pattern().tracks[3]!.steps[4]).toBe(false);
    await beat.interact("Sequencer", "toggle", { track: 3, step: 4 });
    await beat.interact("Sequencer", "tempo", 128);
    await beat.interact("Sequencer", "play");
    expect(beat.output("Sequencer", "playing")).toBe(true);
    expect(pattern()).toMatchObject({ bpm: 128 });
    expect(pattern().tracks[3]!.steps[4]).toBe(true);
    dialogs.saves.push({ name: "First beat" });
    await beat.press("Save button");
    expect(files.list()[0]).toMatchObject({ name: "First beat", kind: "sequencer" });
    await beat.press("New button");
    expect(pattern().tracks[3]!.steps[4]).toBe(false);
    dialogs.opens.push(files.list()[0]!.id);
    await beat.press("Open button");
    expect(pattern()).toMatchObject({ bpm: 128 });
    expect(pattern().tracks[3]!.steps[4]).toBe(true);
  });
});

describe("the document feature", () => {
  it("describes and builds editors from features", async () => {
    const { workspace } = await openWorkspace({ backend: "memory" });
    const plan = { features: [{ kind: "document" as const, editor: "spreadsheet" as const, files: true }] };
    const compiled = compileFeatures(plan, { graph: buildFromFeatures("x", "", { title: "x", features: [] }, workspace.registry), registry: workspace.registry, schemas: workspace.schemas }, [documentFeature]);
    expect(compiled.issues).toEqual([]);
    expect(compiled.described).toEqual(["A spreadsheet with formulas that opens and saves files (New, Open, Save, Save As)"]);
    const unknown = compileFeatures({ features: [{ kind: "document", editor: "violin" as never }] }, { graph: buildFromFeatures("y", "", { title: "y", features: [] }, workspace.registry), registry: workspace.registry, schemas: workspace.schemas }, [documentFeature]);
    expect(unknown.issues).toEqual(['Unknown editor "violin". Use one of: text, richtext, code, spreadsheet, drawing, sequencer.']);
  });
});
