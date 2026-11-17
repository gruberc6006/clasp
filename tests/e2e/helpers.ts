import { test as base, expect, type Locator, type Page } from "@playwright/test";

/** Network failures some tests cause on purpose (e.g. pointing the AI at a dead endpoint). */
const EXPECTED = [/Failed to load resource/i, /ERR_CONNECTION_REFUSED/i];

/**
 * Every browser test fails if the page logs an error or throws — React
 * warnings such as duplicate keys included. Such bugs are often invisible in
 * assertions but show up to people as glitches.
 */
export const test = base.extend<{ consoleGuard: void }>({
  consoleGuard: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (!EXPECTED.some((pattern) => pattern.test(text))) problems.push(text);
      });
      page.on("pageerror", (error) => problems.push(`Uncaught: ${error.message}`));
      await use();
      expect(problems, "The page logged errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** The desktop window(s) of one application. */
export const win = (page: Page, appName: string): Locator => page.locator(`[data-testid="window"][data-app-name="${appName}"]`);

/** A rendered object, by its name in the graph, inside a window or the whole page. */
export const part = (scope: Page | Locator, name: string): Locator => scope.locator(`[data-clasp-name="${name}"]`);

/** Selects an application in the sidebar (which also brings its windows to the front). */
export const openApp = (page: Page, name: string): Promise<void> => page.getByTestId("app-list").getByRole("button", { name, exact: true }).click();

export const mode = (page: Page, name: "Use" | "Build"): Promise<void> => page.getByRole("tab", { name, exact: true }).click();

export async function addTask(page: Page, title: string, appName = "Task Manager"): Promise<void> {
  const window = win(page, appName);
  await window.getByPlaceholder("What needs to be done?").fill(title);
  await window.getByRole("button", { name: "Add task" }).click();
  await expect(part(window, "Task list")).toContainText(title);
}

/** Adds an application from the template gallery (+ → From a template…). */
export async function fromTemplate(page: Page, name: string): Promise<void> {
  await page.getByTestId("new-app").click();
  await page.getByRole("menuitem", { name: /From a template/ }).click();
  await page.getByTestId("template-gallery").getByRole("button", { name, exact: true }).click();
  await expect(page.getByTestId("template-gallery")).toHaveCount(0);
  await expect(page.getByTestId("app-title")).toHaveText(name);
}
