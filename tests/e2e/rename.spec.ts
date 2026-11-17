import { expect, fromTemplate, mode, test, win } from "./helpers";

test("an application can be renamed from its title, the sidebar or the menu", async ({ page }) => {
  await page.goto("/");
  await fromTemplate(page, "Calculator");
  const title = page.getByTestId("app-title");
  const sidebar = page.getByTestId("app-list");

  // 1. Click the name at the top, type, Enter. Its window, titled after the old name, follows.
  await page.getByTestId("app-title-button").click();
  await page.getByTestId("rename-input").fill("Sums");
  await page.getByTestId("rename-input").press("Enter");
  await expect(title).toHaveText("Sums");
  await expect(sidebar.getByRole("button", { name: "Sums", exact: true })).toBeVisible();
  await expect(win(page, "Sums").getByTestId("window-title")).toHaveText("Sums");

  // 2. Escape cancels; an empty name or one another application has is refused.
  await page.getByTestId("app-title-button").click();
  await page.getByTestId("rename-input").fill("Something else");
  await page.getByTestId("rename-input").press("Escape");
  await expect(title).toHaveText("Sums");
  await page.getByTestId("app-title-button").click();
  await page.getByTestId("rename-input").fill("Task Manager");
  await page.getByTestId("rename-input").press("Enter");
  await expect(page.getByTestId("toast")).toContainText("Another application is already called “Task Manager”.");
  await expect(page.getByTestId("rename-input")).toBeVisible(); // still open, to correct it
  await page.getByTestId("rename-input").fill("");
  await page.getByTestId("rename-input").press("Enter");
  await expect(page.getByTestId("toast").filter({ hasText: "An application needs a name." })).toBeVisible();
  await page.getByTestId("rename-input").press("Escape");
  await expect(title).toHaveText("Sums");

  // 3. Double-click it in the sidebar.
  await sidebar.getByRole("button", { name: "Sums", exact: true }).dblclick();
  await sidebar.getByTestId("rename-input").fill("Pocket calculator");
  await sidebar.getByTestId("rename-input").press("Enter");
  await expect(title).toHaveText("Pocket calculator");

  // 4. The … menu.
  await page.getByTestId("app-menu").click();
  await page.getByRole("menuitem", { name: /Rename/ }).click();
  await page.getByTestId("rename-input").fill("Abacus");
  await page.getByTestId("rename-input").press("Enter");
  await expect(title).toHaveText("Abacus");

  // A rename is one undoable step, and it is kept.
  await mode(page, "Build");
  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect(page.getByLabel("Application name")).toHaveValue("Pocket calculator");
  await page.reload();
  await expect(page.getByTestId("app-list").getByRole("button", { name: "Pocket calculator", exact: true })).toBeVisible();
});
