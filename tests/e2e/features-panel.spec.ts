import type { Page } from "@playwright/test";
import { expect, mode, part, test, win } from "./helpers";

const panel = (page: Page) => page.getByTestId("feature-panel");
const row = (page: Page, kind: string) => panel(page).locator(`[data-testid="feature-row"][data-kind="${kind}"]`);

async function add(page: Page, kind: string, fill?: () => Promise<void>): Promise<void> {
  await panel(page).getByTestId("feature-add").click();
  await panel(page).getByTestId(`feature-kind-${kind}`).click();
  await fill?.();
  await panel(page).getByTestId("feature-apply").click();
  await expect(panel(page).getByTestId("feature-form")).toHaveCount(0);
}

test("Features panel: build and change an application one feature at a time, without the wiring", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("new-app").click();
  await page.getByRole("menuitem", { name: /^Blank application/ }).click();
  await mode(page, "Use");
  await page.getByTestId("features-toggle").click();
  await expect(panel(page)).toContainText("Nothing yet.");

  // 1. A new kind of record: books with a title, an author and whether they have been read.
  await panel(page).getByTestId("feature-add").click();
  await panel(page).getByTestId("feature-kind-records").click();
  await panel(page).getByTestId("records-name").fill("Book");
  await panel(page).getByRole("button", { name: "+ Another field" }).click();
  await panel(page).getByLabel("Field 2 name").fill("author");
  await panel(page).getByRole("button", { name: "+ Another field" }).click();
  await panel(page).getByLabel("Field 3 name").fill("read");
  await panel(page).getByLabel("Field 3 type").selectOption("boolean");
  await expect(panel(page).getByTestId("feature-preview")).toContainText("Stores books (title, author, read)");
  await panel(page).getByTestId("feature-apply").click();
  await expect(panel(page).getByTestId("entity-row")).toContainText("Books");
  await expect(row(page, "add")).toContainText("A form to add books (title, author, read)");

  // It works straight away.
  const app = win(page, "Untitled app");
  for (const [title, author] of [["Dune", "Herbert"], ["Emma", "Austen"]]) {
    await app.getByPlaceholder("Book title").fill(title as string);
    await app.getByPlaceholder("Book author").fill(author as string);
    await app.getByRole("button", { name: "Add Book" }).click();
  }
  await expect(part(app, "Book list")).toContainText("Dune");

  // 2. Search, and a sort.
  await add(page, "search");
  await expect(row(page, "search")).toContainText("Search books by title");
  await app.getByPlaceholder("Search books…").fill("dun");
  await expect(part(app, "Book list").locator("li")).toHaveText([/Dune/]);
  await app.getByPlaceholder("Search books…").fill("");
  await add(page, "sort", async () => {
    await panel(page).getByLabel("Order").selectOption("desc");
  });
  await expect(part(app, "Book list").locator("li").first()).toContainText("Emma");

  // 3. Change the sort: the form starts from how it is now.
  await row(page, "sort").getByTestId("feature-change").click();
  await expect(panel(page).getByLabel("Order")).toHaveValue("desc");
  await panel(page).getByLabel("Order").selectOption("asc");
  await expect(panel(page).getByTestId("feature-preview")).toContainText("Sorts books by title");
  await panel(page).getByTestId("feature-apply").click();
  await expect(part(app, "Book list").locator("li").first()).toContainText("Dune");

  // 4. Remove the search: the list keeps working, sorted.
  await row(page, "search").getByTestId("feature-remove").click();
  await expect(row(page, "search")).toHaveCount(0);
  await expect(app.getByPlaceholder("Search books…")).toHaveCount(0);
  await expect(part(app, "Book list").locator("li")).toHaveCount(2);

  // 5. A new field: it joins the records and the form; Undo takes it back as one step.
  await panel(page).getByTestId("entity-add-field").click();
  await panel(page).getByLabel("Field 1 name").fill("pages");
  await panel(page).getByLabel("Field 1 type").selectOption("number");
  await expect(panel(page).getByTestId("feature-preview")).toContainText("Adds pages to the form for new books");
  await panel(page).getByTestId("feature-apply").click();
  await expect(app.getByPlaceholder("Pages")).toBeVisible();
  await expect(panel(page).getByTestId("entity-row")).toContainText("pages");
  await panel(page).getByTestId("feature-undo").click();
  await expect(app.getByPlaceholder("Pages")).toHaveCount(0);

  // 6. Some things are protected, and a feature that cannot be built says why.
  await expect(row(page, "title").getByTestId("feature-remove")).toHaveCount(0);
  await panel(page).getByTestId("feature-add").click();
  await panel(page).getByTestId("feature-kind-calendar").click();
  await expect(panel(page).getByTestId("feature-preview")).toContainText("Book has no date field");
  await expect(panel(page).getByTestId("feature-apply")).toBeDisabled();
  await panel(page).getByTestId("feature-cancel").click();

  // 7. The records were never touched by any of this.
  await page.getByTestId("nav-data").click();
  await page.getByTestId("collection-row").filter({ hasText: "Books" }).click();
  await expect(page.getByTestId("record-row")).toHaveCount(2);
});
