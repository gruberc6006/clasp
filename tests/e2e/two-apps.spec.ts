import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { addTask, expect, openApp, part, test, win } from "./helpers";

/**
 * The primary acceptance test, in a real browser against the real Studio:
 * two independently built applications discover each other, share authorized
 * data, react to changes, persist across a reload, stop sharing on
 * revocation, and can be exported and imported without carrying access along.
 */

/** Asks the Universal API directly, as the dashboard application, whether it may read the collection. */
async function dashboardQuery(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const studio = (window as unknown as { clasp: any }).clasp;
    const apps = studio.workspace.apps();
    const manager = apps.find((app: any) => app.store.graph.metadata.name === "Task Manager");
    const dashboard = apps.find((app: any) => app.store.graph.metadata.name === "Task Dashboard");
    const collection = Object.values(manager.store.graph.objects).find((object: any) => object.type === "data.collection") as { id: string };
    try {
      const result = await dashboard.clasp.query({ source: collection.id });
      return `allowed:${result.total}`;
    } catch (error) {
      return (error as { code: string }).code;
    }
  });
}

test("two applications discover each other, share authorized data, persist, and stop on revocation", async ({ page }) => {
  // 1. Launch Clasp. The first workspace comes with the two demonstration applications, each in its own window.
  await page.goto("/");
  await expect(page.getByText("Build anything. Connect everything.")).toBeVisible();
  await expect(page.getByTestId("app-list").getByRole("button")).toHaveText(["Task Manager", "Task Dashboard"]);
  const manager = win(page, "Task Manager");
  const dashboard = win(page, "Task Dashboard");
  await expect(manager.getByTestId("window-title")).toHaveText("Task Manager");
  await expect(dashboard.getByTestId("window-title")).toHaveText("Task Dashboard");

  // 2. Open Task Manager. 3. Create a task.
  await expect(page.getByTestId("app-title")).toHaveText("Task Manager");
  await addTask(page, "Write the spec");
  await expect(part(manager, "Remaining label")).toHaveText("1 remaining");

  // 4. Open Task Dashboard: it discovers the collection but shows no data.
  await openApp(page, "Task Dashboard");
  await expect(page.getByTestId("app-title")).toHaveText("Task Dashboard");
  await expect(part(dashboard, "Connect heading")).toHaveText("Connect a task collection");
  await expect(part(dashboard, "Available sources").locator("li")).toHaveText([/Tasks\s*Task Manager/]);
  await expect(part(dashboard, "Task table")).toHaveCount(0);
  expect(await dashboardQuery(page)).toBe("PERMISSION_DENIED");

  await part(dashboard, "Available sources").locator("li").first().click();
  await expect(part(dashboard, "Access explanation")).toHaveText("This dashboard needs permission to read “Tasks” from Task Manager.");
  await expect(part(dashboard, "Task table")).toHaveCount(0);

  // 5. Grant the dashboard read access — through the permission prompt.
  await dashboard.getByRole("button", { name: "Request read access" }).click();
  const prompt = page.getByTestId("permission-prompt");
  await expect(prompt).toContainText("Allow “Task Dashboard” to access “Tasks”?");
  await expect(prompt).toContainText("Read records");
  await expect(prompt).toContainText("Show your tasks on the dashboard.");
  expect(await dashboardQuery(page)).toBe("PERMISSION_DENIED"); // asking is not having
  await page.getByTestId("permission-allow").click();

  // 6. The task appears.
  await expect(part(dashboard, "Task table").locator("tbody tr")).toHaveText([/Write the spec/]);
  await expect(part(dashboard, "Total stat")).toContainText("1");
  await expect(part(dashboard, "Source label")).toHaveText("Live from “Tasks” · Task Manager");
  expect(await dashboardQuery(page)).toBe("allowed:1");

  // 7. Edit the task in Task Manager — the dashboard window stays open beside it…
  await manager.getByRole("button", { name: "Edit Write the spec" }).click();
  await manager.getByRole("textbox", { name: "Write the spec" }).fill("Write the spec (v2)");
  await page.keyboard.press("Enter");
  await expect(part(manager, "Task list")).toContainText("Write the spec (v2)");
  await expect(page.getByTestId("app-title")).toHaveText("Task Manager"); // clicking a window focuses its app
  // 8. …and updates by itself.
  await expect(part(dashboard, "Task table").locator("tbody tr")).toHaveText([/Write the spec \(v2\)/]);

  await addTask(page, "Ship it");
  await manager.getByRole("checkbox", { name: "Mark complete: Write the spec (v2)" }).click();
  await expect(part(manager, "Remaining label")).toHaveText("1 remaining");
  // "View active tasks".
  await manager.getByRole("tab", { name: "Active" }).click();
  await expect(part(manager, "Task list").locator("li")).toHaveText([/Ship it/]);
  await manager.getByRole("tab", { name: "All" }).click();

  await expect(part(dashboard, "Task table").locator("tbody tr")).toHaveText([/Write the spec \(v2\)/, /Ship it/]);
  await expect(part(dashboard, "Active stat")).toContainText("1");
  await expect(part(dashboard, "Completed stat")).toContainText("1");
  await dashboard.getByRole("tab", { name: "Completed" }).click();
  await expect(part(dashboard, "Task table").locator("tbody tr")).toHaveText([/Write the spec \(v2\)/]);
  await dashboard.getByRole("tab", { name: "Active" }).click();
  await expect(part(dashboard, "Task table").locator("tbody tr")).toHaveText([/Ship it/]);
  await dashboard.getByRole("tab", { name: "All" }).click();

  // 9. Reload Clasp. 10. Both applications and their data persist.
  await page.reload();
  await expect(page.getByTestId("app-list").getByRole("button")).toHaveText(["Task Manager", "Task Dashboard"]);
  await expect(part(dashboard, "Task table").locator("tbody tr")).toHaveText([/Write the spec \(v2\)/, /Ship it/]);
  await expect(part(manager, "Task list").locator("li")).toHaveText([/Write the spec \(v2\)/, /Ship it/]);
  await expect(part(manager, "Task list").locator('li[data-checked="true"]')).toHaveCount(1);

  // The data explorer shows the same records, owned by the Task Manager.
  await page.getByTestId("nav-data").click();
  await expect(page.getByTestId("collection-detail")).toContainText("Owned by Task Manager");
  await expect(page.getByTestId("record-row")).toHaveCount(2);

  // 11. Revoke the dashboard's permission.
  await page.getByTestId("nav-permissions").click();
  const card = page.locator('[data-testid="permission-card"][data-app="Task Dashboard"]');
  await expect(card.getByTestId("grant-row")).toHaveCount(1);
  await expect(card.getByTestId("grant-row")).toContainText("Read records of “Tasks”");
  await card.getByTestId("revoke-grant").click();
  await expect(card.getByTestId("no-grants")).toBeVisible();

  // 12. Subsequent queries and updates are denied.
  expect(await dashboardQuery(page)).toBe("PERMISSION_DENIED");
  await openApp(page, "Task Dashboard");
  await expect(part(dashboard, "Task table")).toHaveCount(0);
  await expect(part(dashboard, "Access explanation")).toBeVisible();
  await addTask(page, "Added after revocation");
  await expect(dashboard).not.toContainText("Added after revocation");
  await expect(part(dashboard, "Task table")).toHaveCount(0);
  // …and it stays revoked across a reload.
  await page.reload();
  await expect(part(dashboard, "Access explanation")).toBeVisible();
  await expect(part(dashboard, "Task table")).toHaveCount(0);

  // 13. Export the dashboard. The package contains no records and no grants.
  await openApp(page, "Task Dashboard");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-app").click()]);
  expect(download.suggestedFilename()).toBe("task-dashboard.clasp.json");
  const text = await readFile(await download.path(), "utf8");
  const pkg = JSON.parse(text) as { format: string; requires: { capabilities: Array<{ capability: string }> } };
  expect(pkg.format).toBe("clasp.package");
  expect(pkg.requires.capabilities.map((entry) => entry.capability)).toEqual(["collection.query"]);
  expect(text).not.toContain("Ship it");
  expect(text).not.toContain("grant_");

  // 14. Import it into another workspace.
  await page.getByTestId("workspace-switcher").click();
  await page.getByRole("menuitem", { name: "New workspace…" }).click();
  await page.getByLabel("Name").fill("Second workspace");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByTestId("workspace-switcher")).toContainText("Second workspace");
  await expect(page.getByTestId("app-list").getByRole("button")).toHaveCount(0);
  await page.getByTestId("import-file").setInputFiles({ name: "task-dashboard.clasp.json", mimeType: "application/json", buffer: Buffer.from(text) });

  // 15. The imported application has no access to anything.
  await expect(page.getByTestId("app-title")).toHaveText("Task Dashboard");
  await expect(part(dashboard, "Task table")).toHaveCount(0);
  await expect(part(dashboard, "Available sources")).toContainText("No task collections are shared in this workspace yet.");
  await page.getByTestId("nav-permissions").click();
  await expect(page.getByTestId("grant-row")).toHaveCount(0);
  await expect(page.getByTestId("requirement-row")).toContainText("not available here");

  // The same holds when it is imported next to the original: a new identity, no inherited grant.
  await page.getByTestId("workspace-switcher").click();
  await page.getByRole("menuitem", { name: "Personal" }).click();
  await expect(page.getByTestId("app-list").getByRole("button")).toHaveText(["Task Manager", "Task Dashboard"]);
  await page.getByTestId("import-file").setInputFiles({ name: "task-dashboard.clasp.json", mimeType: "application/json", buffer: Buffer.from(text) });
  await expect(page.getByTestId("app-list").getByRole("button")).toHaveText(["Task Manager", "Task Dashboard", "Task Dashboard 2"]);
  await expect(page.getByTestId("app-title")).toHaveText("Task Dashboard 2");
  const copy = win(page, "Task Dashboard 2");
  await expect(part(copy, "Access explanation")).toHaveText("This dashboard needs permission to read “Tasks” from Task Manager.");
  await expect(part(copy, "Task table")).toHaveCount(0);
  await expect(copy).not.toContainText("Ship it");
});

test("denying a request leaves the application without data", async ({ page }) => {
  await page.goto("/");
  await addTask(page, "Confidential");
  const dashboard = win(page, "Task Dashboard");
  await part(dashboard, "Available sources").locator("li").first().click();
  await dashboard.getByRole("button", { name: "Request read access" }).click();
  await page.getByTestId("permission-deny").click();
  await expect(page.getByTestId("permission-prompt")).toHaveCount(0);
  await expect(part(dashboard, "Task table")).toHaveCount(0);
  await expect(dashboard).not.toContainText("Confidential");
  expect(await dashboardQuery(page)).toBe("PERMISSION_DENIED");
});

test("windows can be moved, maximized, minimized, closed and brought back", async ({ page }) => {
  await page.goto("/");
  const manager = win(page, "Task Manager");
  const dashboard = win(page, "Task Dashboard");
  await expect(manager).toBeVisible();
  await expect(dashboard).toBeVisible();
  // They open side by side (measured once the opening animation has finished).
  await page.waitForTimeout(400);
  const [a, b] = [await manager.boundingBox(), await dashboard.boundingBox()];
  expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x);

  // Drag by the title bar.
  const bar = manager.getByTestId("window-titlebar");
  const start = (await bar.boundingBox())!;
  // Grab the middle of the title bar (the traffic lights sit at its left end).
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 100, start.y + start.height / 2 + 220, { steps: 8 });
  await page.mouse.up();
  const moved = (await manager.boundingBox())!;
  expect(Math.round(moved.x - a!.x)).toBe(100);
  expect(Math.round(moved.y - a!.y)).toBe(220);
  await expect(manager).toHaveAttribute("data-focused", "true");
  await expect(page.getByTestId("app-title")).toHaveText("Task Manager");

  // Resize from the corner.
  const corner = (await manager.getByTestId("window-resize").boundingBox())!;
  await page.mouse.move(corner.x + 8, corner.y + 8);
  await page.mouse.down();
  await page.mouse.move(corner.x + 88, corner.y + 8, { steps: 6 });
  await page.mouse.up();
  expect(Math.round((await manager.boundingBox())!.width - moved.width)).toBe(80);

  // The layout survives a reload.
  await page.waitForTimeout(400);
  await page.reload();
  const restored = (await win(page, "Task Manager").boundingBox())!;
  expect(Math.round(restored.x)).toBe(Math.round(moved.x));
  expect(Math.round(restored.width - moved.width)).toBe(80);

  // Maximize fills the desktop; restore puts it back.
  await manager.getByTestId("window-maximize").click();
  const desk = (await page.getByTestId("desktop").boundingBox())!;
  await expect.poll(async () => Math.round((await manager.boundingBox())!.width)).toBe(Math.round(desk.width - 16));
  await manager.getByRole("button", { name: "Restore window" }).click();
  await expect.poll(async () => Math.round((await manager.boundingBox())!.width)).toBe(Math.round(restored.width));

  // Minimize sends it to the window bar and passes focus on; clicking it there brings it back.
  await manager.getByTestId("window-minimize").click();
  await expect(manager).toHaveCount(0);
  await expect(page.getByTestId("app-title")).toHaveText("Task Dashboard");
  const item = page.locator('[data-testid="window-bar-item"][data-window-title="Task Manager"]');
  await expect(item).toHaveAttribute("data-minimized", "true");
  await item.click();
  await expect(manager).toBeVisible();
  await expect(page.getByTestId("app-title")).toHaveText("Task Manager");

  // Closing a window keeps the app running; selecting the app reopens it.
  await addTask(page, "Still running");
  await manager.getByTestId("window-close").click();
  await expect(manager).toHaveCount(0);
  // A closed window stays in the bar, so it never vanishes without a way back.
  await expect(item).toHaveAttribute("data-closed", "true");
  await item.click();
  await expect(part(manager, "Task list")).toContainText("Still running");
  // Selecting the app in the sidebar reopens it too.
  await manager.getByTestId("window-close").click();
  await openApp(page, "Task Manager");
  await expect(part(manager, "Task list")).toContainText("Still running");
});
