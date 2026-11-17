import { addTask, expect, mode, openApp, part, test, win } from "./helpers";

test("Use mode and Build mode share one graph and one running application", async ({ page }) => {
  await page.goto("/");
  const manager = win(page, "Task Manager");
  const draft = manager.getByPlaceholder("What needs to be done?");
  await draft.fill("Unsaved draft");

  // Build mode shows the same application as a graph.
  await mode(page, "Build");
  await expect(page.getByTestId("graph-node")).toHaveCount(10);
  await expect(page.locator('[data-testid="graph-node"][data-name="Tasks"]')).toContainText("data.collection");
  await expect(page.locator(".react-flow__edge")).toHaveCount(10);
  await expect(page.getByTestId("app-inspector")).toContainText("10 objects");

  // Switching modes loses nothing: the half-typed text is still there.
  await mode(page, "Use");
  await expect(draft).toHaveValue("Unsaved draft");

  // Edit a property in the inspector…
  await mode(page, "Build");
  await page.getByRole("tab", { name: /Outline/ }).click();
  await page.locator('[data-testid="outline-row"][data-name="Add button"]').click();
  const inspector = page.getByTestId("object-inspector");
  await expect(inspector).toContainText("ui.button");
  const label = inspector.getByLabel("Label", { exact: true });
  await expect(label).toHaveValue("Add task");
  await label.fill("Create");
  await label.press("Enter");

  // …and the running application changes, keeping its state.
  await mode(page, "Use");
  await expect(manager.getByRole("button", { name: "Create", exact: true })).toBeVisible();
  await expect(draft).toHaveValue("Unsaved draft");
  await manager.getByRole("button", { name: "Create", exact: true }).click();
  await expect(part(manager, "Task list")).toContainText("Unsaved draft");

  // Undo reverts the definition; the data stays.
  await mode(page, "Build");
  await page.getByRole("button", { name: /^Undo/ }).click();
  await mode(page, "Use");
  await expect(manager.getByRole("button", { name: "Add task", exact: true })).toBeVisible();
  await expect(part(manager, "Task list")).toContainText("Unsaved draft");

  // Add a component from the library and configure it.
  await mode(page, "Build");
  await page.getByRole("tab", { name: "Components" }).click();
  await page.getByTestId("library-ui.text").click();
  await expect(page.getByTestId("graph-node")).toHaveCount(11);
  const text = page.getByTestId("object-inspector").getByLabel("Text", { exact: true });
  await text.fill("Hello from Build mode");
  await text.blur();
  await mode(page, "Use");
  await expect(manager).toContainText("Hello from Build mode");

  // The edit was saved: it survives a reload, and so does the data.
  await page.reload();
  await expect(manager).toContainText("Hello from Build mode");
  await expect(part(manager, "Task list")).toContainText("Unsaved draft");

  // Invalid edits are rejected as a whole and explained.
  await mode(page, "Build");
  await page.getByRole("tab", { name: /Outline/ }).click();
  await page.locator('[data-testid="outline-row"][data-name="Status tabs"]').click();
  const options = page.getByTestId("object-inspector").getByLabel("Options", { exact: true });
  await options.fill("{ not json");
  await options.blur();
  await expect(page.getByTestId("toast").last()).toContainText("not valid JSON");
  await options.fill('{"an":"object"}');
  await options.blur();
  await expect(page.getByTestId("toast").last()).toContainText("must be a list");

  // Deleting an object removes its node.
  await page.locator('[data-testid="outline-row"][data-name="Text"]').click();
  await page.getByTestId("delete-object").click();
  await expect(page.getByTestId("graph-node")).toHaveCount(10);
  await mode(page, "Use");
  await expect(manager).not.toContainText("Hello from Build mode");
});

test("forking makes an independent application; deleting can keep or erase data", async ({ page }) => {
  await page.goto("/");
  await addTask(page, "Original task");

  await page.getByTestId("app-menu").click();
  await page.getByRole("menuitem", { name: /Fork/ }).click();
  await expect(page.getByTestId("app-title")).toHaveText("Task Manager (fork)");
  await expect(page.getByText("from Task Manager")).toBeVisible();
  // The fork opens in its own window, with its own, empty collection.
  const fork = win(page, "Task Manager (fork)");
  await expect(part(fork, "Task list")).toContainText("No tasks here");
  await addTask(page, "Fork task", "Task Manager (fork)");

  await openApp(page, "Task Manager");
  await expect(part(win(page, "Task Manager"), "Task list").locator("li")).toHaveText([/Original task/]);

  // Delete the fork but keep its data: the records remain visible to the user.
  await openApp(page, "Task Manager (fork)");
  await page.getByTestId("app-menu").click();
  await page.getByRole("menuitem", { name: /Delete/ }).click();
  await page.getByRole("button", { name: "Delete application" }).click();
  await expect(page.getByTestId("app-list").getByRole("button")).toHaveText(["Task Manager", "Task Dashboard"]);
  await expect(fork).toHaveCount(0);
  await page.getByTestId("nav-data").click();
  await expect(page.getByTestId("data-explorer")).toContainText("Records without an owner");
});

test("switching applications in Build mode leaves exactly one editor and one AI panel", async ({ page }) => {
  await page.goto("/");
  await mode(page, "Build");
  await page.getByTestId("ai-toggle").click();
  for (const name of ["Task Dashboard", "Task Manager", "Task Dashboard", "Task Manager"]) {
    await openApp(page, name);
    await expect(page.getByLabel("Application name")).toHaveValue(name);
    await expect(page.getByTestId("build-mode")).toHaveCount(1);
    await expect(page.getByTestId("ai-panel")).toHaveCount(1);
  }
  // Each editor shows the selected application's graph, not a leftover one.
  await expect(page.getByRole("tab", { name: /Outline/ })).toHaveText("Outline · 10");
  await openApp(page, "Task Dashboard");
  await expect(page.getByRole("tab", { name: /Outline/ })).toHaveText("Outline · 32");
});
