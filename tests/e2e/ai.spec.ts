import { addTask, expect, mode, openApp, part, test, win } from "./helpers";

const CREATE = "Create a simple task manager with a title field, an Add Task button, and a list of tasks.";
const FILTER = "Add a filter to show only incomplete tasks.";

/**
 * These tests use the scripted provider, which is NOT a language model: it
 * replays predefined plans. They verify the pipeline around the model
 * (propose → validate → approve → execute). Real local inference is covered
 * by tests/ollama.live.test.ts.
 */
test("AI panel: propose, approve, run — then modify without losing data (scripted provider)", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("new-app").click();
  await page.getByRole("menuitem", { name: /Describe with AI/ }).click();
  const panel = page.getByTestId("ai-panel");
  await expect(panel).toBeVisible();

  await panel.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("ai-provider").selectOption("scripted");
  await expect(page.getByTestId("ai-status")).toHaveText("Scripted demo provider — not an AI");
  await panel.getByRole("button", { name: "Done" }).click();

  // Request 1: create.
  await page.getByTestId("ai-input").fill(CREATE);
  await page.getByTestId("ai-send").click();
  const first = page.getByTestId("ai-proposal").first();
  await expect(first).toContainText("scripted — not an AI");
  // The proposal reads as features; the underlying graph changes are one click away.
  await expect(first.getByTestId("ai-features")).toContainText("A form to add tasks (title)");
  await expect(first.getByTestId("ai-features")).toContainText("A list of tasks you can tick off as completed, edit, remove");
  await expect(first).toContainText("13 changes");
  // The app is still "Untitled app", so the proposal names it — avoiding the existing Task Manager's name.
  await expect(first.getByTestId("ai-features")).toContainText("Names the application “Task Manager 2”");
  // A proposal is only a proposal: the graph is still empty.
  await expect(page.getByTestId("graph-node")).toHaveCount(0);
  await first.getByTestId("ai-apply").click();
  await expect(first).toHaveAttribute("data-state", "applied");
  await expect(page.getByTestId("graph-node")).toHaveCount(6);

  // The generated application opens in its own window and runs without any model.
  await mode(page, "Use");
  await expect(page.getByTestId("app-title")).toHaveText("Task Manager 2");
  const generated = win(page, "Task Manager 2");
  await expect(generated.getByTestId("window-title")).toHaveText("Task Manager");
  for (const title of ["Buy milk", "Walk the dog"]) {
    await generated.getByPlaceholder("Task title").fill(title);
    await generated.getByRole("button", { name: "Add Task", exact: true }).click();
    await expect(part(generated, "Task list")).toContainText(title);
  }
  await generated.getByRole("checkbox", { name: "Mark complete: Buy milk" }).click();
  await expect(part(generated, "Task list").locator('li[data-checked="true"]')).toHaveCount(1);

  // Request 2: modify the existing application.
  await page.getByTestId("ai-input").fill(FILTER);
  await page.getByTestId("ai-send").click();
  const second = page.getByTestId("ai-proposal").nth(1);
  await expect(second).toContainText("Incomplete filter");
  await expect(part(generated, "Task list").locator("li")).toHaveCount(2); // not applied yet
  await second.getByTestId("ai-apply").click();
  await expect(part(generated, "Task list").locator("li")).toHaveText([/Walk the dog/]);

  // Both records are still there; only the view changed.
  await page.getByTestId("nav-data").click();
  await page.getByTestId("collection-row").filter({ hasText: "Task Manager 2" }).click();
  await expect(page.getByTestId("record-row")).toHaveCount(2);

  // A request the script does not know is refused honestly.
  await openApp(page, "Task Manager 2");
  await page.getByTestId("ai-input").fill("Build me a spaceship");
  await page.getByTestId("ai-send").click();
  await expect(page.getByTestId("ai-error")).toContainText("not an AI");
});

test("without a local model the Studio says so and everything else keeps working", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-title")).toHaveText("Task Manager");
  // Point at a dead endpoint so the result does not depend on whether Ollama happens to be running here.
  await page.evaluate(() => (window as unknown as { clasp: any }).clasp.setAi({ provider: "ollama", baseUrl: "http://127.0.0.1:9" }));
  await page.getByTestId("ai-toggle").click();
  await expect(page.getByTestId("ai-unavailable")).toContainText("AI generation is temporarily unavailable");
  await expect(page.getByTestId("ai-unavailable")).toContainText("Existing applications keep working");

  await page.getByTestId("ai-input").fill("Add a clock");
  await page.getByTestId("ai-send").click();
  await expect(page.getByTestId("ai-error")).toContainText("AI generation is unavailable right now");

  // Existing applications run, and manual editing is available.
  await addTask(page, "No AI required");
  await mode(page, "Build");
  await expect(page.getByTestId("graph-node")).toHaveCount(10);
});
