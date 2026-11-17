import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { expect, fromTemplate, part, test, win } from "./helpers";

const newFromTemplate = fromTemplate;

/** Opens a cell for editing and types into it, as a person would. */
async function enter(page: Page, sheet: ReturnType<typeof win>, cell: string, text: string): Promise<void> {
  await sheet.locator(`[data-cell="${cell}"]`).dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

test("Spreadsheet: formulas, Save As, the Files view, and reopening a file", async ({ page }) => {
  await page.goto("/");
  await newFromTemplate(page, "Spreadsheet");
  const sheet = win(page, "Spreadsheet");
  await expect(sheet.getByTestId("window-title")).toHaveText("Untitled sheet");

  await enter(page, sheet, "A1", "Rent");
  await enter(page, sheet, "B1", "1200");
  await enter(page, sheet, "A2", "Food");
  await enter(page, sheet, "B2", "450");
  await enter(page, sheet, "B3", "=SUM(B1:B2)");
  await enter(page, sheet, "C3", "=B3/2");
  await expect(sheet.locator('[data-cell="B3"]')).toHaveText("1650");
  await expect(sheet.locator('[data-cell="C3"]')).toHaveText("825");
  await sheet.locator('[data-cell="B3"]').click();
  await expect(sheet.getByTestId("sheet-formula")).toHaveValue("=SUM(B1:B2)");
  await expect(sheet.getByTestId("window-title")).toHaveText("Untitled sheet — Edited");

  // Typing straight into a selected cell, and Escape cancelling, work like a desktop spreadsheet.
  await sheet.locator('[data-cell="A3"]').click();
  await page.keyboard.type("Total");
  await page.keyboard.press("Tab");
  await expect(sheet.locator('[data-cell="A3"]')).toHaveText("Total");
  await page.keyboard.type("999");
  await page.keyboard.press("Escape");
  await expect(sheet.locator('[data-cell="B3"]')).toHaveText("1650");

  // Save asks for a name; the file then belongs to the user, opened only in this app.
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  const dialog = page.getByTestId("file-dialog");
  await expect(dialog).toContainText("Save As");
  await page.getByTestId("file-dialog-name").fill("Budget");
  await page.getByTestId("file-dialog-confirm").click();
  await expect(sheet.getByTestId("window-title")).toHaveText("Budget");

  await page.getByTestId("nav-files").click();
  const row = page.locator('[data-testid="file-row"][data-name="Budget"]');
  await expect(row).toContainText("spreadsheet");
  await expect(row).toContainText("Spreadsheet");

  // Download a copy to the computer.
  const [download] = await Promise.all([page.waitForEvent("download"), row.getByRole("button", { name: "Download Budget" }).click()]);
  expect(download.suggestedFilename()).toBe("Budget.spreadsheet.clasp.json");
  const copy = JSON.parse(await readFile(await download.path(), "utf8")) as { format: string; content: { cells: Record<string, string> } };
  expect(copy.format).toBe("clasp.file");
  expect(copy.content.cells.B3).toBe("=SUM(B1:B2)");

  // After a reload the app reopens the file it was working on.
  await page.reload();
  await expect(sheet.getByTestId("window-title")).toHaveText("Budget");
  await expect(sheet.locator('[data-cell="B3"]')).toHaveText("1650");

  // New, then Open brings it back through the Open dialog.
  await sheet.getByRole("button", { name: "New", exact: true }).click();
  await expect(sheet.locator('[data-cell="B3"]')).toHaveText("");
  await sheet.getByRole("button", { name: "Open…" }).click();
  await expect(dialog).toContainText("Open a spreadsheet");
  await expect(dialog).toContainText("will be able to open and save the file you choose — and only that file");
  await dialog.locator('[data-testid="file-choice"][data-name="Budget"]').click();
  await page.getByTestId("file-dialog-confirm").click();
  await expect(sheet.locator('[data-cell="B3"]')).toHaveText("1650");
});

test("files from the computer, and apps only see the files picked for them", async ({ page }) => {
  await page.goto("/");
  // Bring a CSV in from "the computer": it becomes a spreadsheet document.
  await page.getByTestId("nav-files").click();
  await page.getByTestId("files-upload-input").setInputFiles({ name: "scores.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Score\nAda,91\n\"Lovelace, A\",88\n") });
  await expect(page.locator('[data-testid="file-row"][data-name="scores"]')).toContainText("No application");
  await page.getByTestId("files-upload-input").setInputFiles({ name: "todo.txt", mimeType: "text/plain", buffer: Buffer.from("buy milk") });
  await expect(page.locator('[data-testid="file-row"][data-name="todo"]')).toContainText("text document");

  // Notes' Open dialog offers text documents only.
  await newFromTemplate(page, "Notes");
  const notes = win(page, "Notes");
  await notes.getByRole("button", { name: "Open…" }).click();
  const dialog = page.getByTestId("file-dialog");
  await expect(dialog.getByTestId("file-choice")).toHaveText([/todo/]);
  await dialog.getByTestId("file-choice").first().dblclick();
  await expect(notes.getByRole("textbox")).toHaveValue("buy milk");
  await expect(notes.getByTestId("window-title")).toHaveText("todo");

  // The Spreadsheet opens the CSV as a sheet.
  await newFromTemplate(page, "Spreadsheet");
  const sheet = win(page, "Spreadsheet");
  await sheet.getByRole("button", { name: "Open…" }).click();
  await expect(dialog.getByTestId("file-choice")).toHaveText([/scores/]);
  await dialog.getByTestId("file-choice").first().dblclick();
  await expect(sheet.locator('[data-cell="A3"]')).toHaveText("Lovelace, A");
  await expect(sheet.locator('[data-cell="B2"]')).toHaveText("91");

  // Each app was given exactly the file the user picked; the Files view shows it, and access can be taken back.
  await page.getByTestId("nav-files").click();
  await expect(page.locator('[data-testid="file-row"][data-name="todo"]')).toContainText("Notes");
  await expect(page.locator('[data-testid="file-row"][data-name="todo"]')).not.toContainText("Spreadsheet");
  const denied = await page.evaluate(async () => {
    const studio = (window as unknown as { clasp: any }).clasp;
    const sheetApp = studio.workspace.apps().find((app: any) => app.store.graph.metadata.name === "Spreadsheet");
    const todo = studio.files.list().find((file: any) => file.name === "todo");
    try {
      await sheetApp.clasp.invoke({ target: "clasp.files", action: "read", arguments: { fileId: todo.id } });
      return "allowed";
    } catch (error) {
      return (error as { code: string }).code;
    }
  });
  expect(denied).toBe("PERMISSION_DENIED");
  await page.locator('[data-testid="file-row"][data-name="todo"]').getByRole("button", { name: "Revoke access to todo" }).click();
  await expect(page.locator('[data-testid="file-row"][data-name="todo"]')).toContainText("No application");
});

test("Sketchpad and Beat Maker save and open their documents", async ({ page }) => {
  await page.goto("/");
  await newFromTemplate(page, "Sketchpad");
  const pad = win(page, "Sketchpad");
  const surface = pad.getByTestId("drawing-surface");
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 10 });
  await page.mouse.up();
  await expect(pad.getByTestId("window-title")).toHaveText("Untitled drawing — Edited");
  await pad.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByTestId("file-dialog-name").fill("Doodle");
  await page.getByTestId("file-dialog-confirm").click();
  await expect(pad.getByTestId("window-title")).toHaveText("Doodle");
  await pad.getByRole("button", { name: "Undo" }).click();
  await expect(pad.getByTestId("window-title")).toHaveText("Doodle — Edited");

  await newFromTemplate(page, "Beat Maker");
  const beat = win(page, "Beat Maker");
  const clap = beat.getByRole("gridcell", { name: "Clap step 5" });
  await expect(clap).toHaveAttribute("aria-pressed", "false");
  await clap.click();
  await expect(clap).toHaveAttribute("aria-pressed", "true");
  await beat.getByTestId("sequencer-play").click();
  await expect(beat.getByTestId("sequencer-play")).toHaveText("Stop");
  await beat.getByTestId("sequencer-play").click();
  await beat.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByTestId("file-dialog-name").fill("Groove");
  await page.getByTestId("file-dialog-confirm").click();
  await expect(beat.getByTestId("window-title")).toHaveText("Groove");
  await beat.getByRole("button", { name: "New", exact: true }).click();
  await expect(clap).toHaveAttribute("aria-pressed", "false");
  await beat.getByRole("button", { name: "Open…" }).click();
  await page.getByTestId("file-dialog").locator('[data-testid="file-choice"][data-name="Groove"]').dblclick();
  await expect(clap).toHaveAttribute("aria-pressed", "true");
});

test("describing an application by its features (scripted provider — not an AI)", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("new-app").click();
  await page.getByRole("menuitem", { name: /Describe with AI/ }).click();
  await page.getByTestId("ai-panel").getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("ai-provider").selectOption("scripted");
  await page.getByTestId("ai-panel").getByRole("button", { name: "Done" }).click();
  await page.getByTestId("ai-input").fill("A recipe box where I can add recipes with servings and whether they are vegetarian, search them, and filter to vegetarian ones.");
  await page.getByTestId("ai-send").click();
  const proposal = page.getByTestId("ai-proposal");
  await expect(proposal.getByTestId("ai-features")).toContainText("Stores recipes (title, servings, vegetarian)");
  await expect(proposal.getByTestId("ai-features")).toContainText("Search recipes by title");
  await proposal.getByTestId("ai-apply").click();

  await page.getByRole("tab", { name: "Use", exact: true }).click();
  const app = win(page, "Recipe Box");
  await expect(app.getByTestId("window-title")).toHaveText("Recipe Box");
  for (const [title, vegetarian] of [
    ["Tomato soup", true],
    ["Beef stew", false],
  ] as const) {
    await app.getByPlaceholder("Recipe title").fill(title);
    if (vegetarian) await app.getByRole("checkbox", { name: "Vegetarian" }).click();
    await app.getByRole("button", { name: "Add Recipe" }).click();
    await expect(part(app, "Recipe list")).toContainText(title);
  }
  await expect(app).toContainText("2 recipes");
  await app.getByPlaceholder("Search recipes…").fill("stew");
  await expect(part(app, "Recipe list").locator("li")).toHaveText([/Beef stew/]);
  await app.getByPlaceholder("Search recipes…").fill("");
  await app.getByRole("tab", { name: "Vegetarian", exact: true }).click();
  await expect(part(app, "Recipe list").locator("li")).toHaveText([/Tomato soup/]);
});

test("asking for a new app creates a new application, not a change to the open one (scripted provider)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-title")).toHaveText("Task Manager");
  await page.getByTestId("ai-toggle").click();
  await page.getByTestId("ai-panel").getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("ai-provider").selectOption("scripted");
  await page.getByTestId("ai-panel").getByRole("button", { name: "Done" }).click();

  await page.getByTestId("ai-input").fill("make a calendar app");
  await page.getByTestId("ai-send").click();
  const card = page.getByTestId("ai-proposal");
  await expect(card).toHaveAttribute("data-target", "new");
  await expect(card.getByTestId("ai-target")).toContainText("Creates a new application “Calendar”");
  await expect(card.getByTestId("ai-features")).toContainText("A month calendar of events by start");

  // One click switches the same plan to the open application, and back.
  await card.getByTestId("ai-switch-target").click();
  await expect(card).toHaveAttribute("data-target", "current");
  await expect(card.getByTestId("ai-target")).toContainText("Changes “Task Manager”");
  await card.getByTestId("ai-switch-target").click();
  await expect(card).toHaveAttribute("data-target", "new");

  await card.getByRole("button", { name: "Create app" }).click();
  await expect(page.getByTestId("app-list").getByRole("button")).toHaveText(["Task Manager", "Task Dashboard", "Calendar"]);
  await expect(page.getByTestId("app-title")).toHaveText("Calendar");
  await expect(win(page, "Calendar").getByTestId("calendar-month")).toBeVisible();

  // The Task Manager was not touched.
  await page.getByTestId("app-list").getByRole("button", { name: "Task Manager", exact: true }).click();
  await page.getByRole("tab", { name: "Build", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Outline/ })).toHaveText("Outline · 10");
  // Its conversation still shows what happened.
  await expect(page.getByTestId("ai-proposal")).toContainText("Created “Calendar”");
});

test("Calendar: pick a day, add an event, see it on that day", async ({ page }) => {
  await page.goto("/");
  await newFromTemplate(page, "Calendar");
  const calendar = win(page, "Calendar");
  const month = await calendar.getByTestId("calendar-month").textContent();
  // Pick the 15th of the month on screen.
  const day = calendar.locator('[role="gridcell"][data-day$="-15"]').first();
  const date = (await day.getAttribute("data-day"))!;
  await day.click();
  await expect(calendar.getByLabel("Starts")).toHaveValue(date);
  await calendar.getByPlaceholder("Event title").fill("Dentist");
  await calendar.getByRole("button", { name: "Add event" }).click();
  await expect(calendar.locator(`[data-day="${date}"]`).getByTestId("calendar-entry")).toHaveText("Dentist");
  await expect(part(calendar, "Upcoming events")).toContainText("Dentist");
  // Navigating months is just a view change.
  await calendar.getByRole("button", { name: "Next month" }).click();
  await expect(calendar.getByTestId("calendar-month")).not.toHaveText(month!);
  await calendar.getByRole("button", { name: "Today" }).click();
  await expect(calendar.getByTestId("calendar-month")).toHaveText(month!);
});
