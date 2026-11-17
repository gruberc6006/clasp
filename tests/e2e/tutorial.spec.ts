import type { Page } from "@playwright/test";
import { expect, mode, part, test, win } from "./helpers";

/**
 * Follows both in-app tutorials exactly as a newcomer would, checking that
 * every step ticks itself off. With CLASP_TUTORIAL_SHOTS=1 it also saves the
 * screenshots used by docs/tutorial.md.
 */

const SHOTS = process.env.CLASP_TUTORIAL_SHOTS === "1";

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(350); // let animations settle
  await page.screenshot({ path: `docs/tutorial/${name}.png` });
}

const tutorial = (page: Page) => page.getByTestId("tutorial");
const expectStep = (page: Page, id: string) => expect(tutorial(page)).toHaveAttribute("data-step", id);

async function start(page: Page, id: "by-hand" | "with-ai"): Promise<void> {
  await page.goto("/");
  await page.getByTestId("nav-learn").click();
  await expect(page.getByTestId("tutorial-picker")).toBeVisible();
  await page.getByTestId(`start-tutorial-${id}`).click();
}

/** Selects an object in Build mode through the outline, then returns to the component library. */
async function select(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name: /Outline/ }).click();
  await page.locator(`[data-testid="outline-row"][data-name="${name}"]`).click();
  await page.getByRole("tab", { name: "Components" }).click();
}

async function setProperty(page: Page, id: string, value: string): Promise<void> {
  const field = page.getByTestId("object-inspector").locator(`#${id}`);
  await field.fill(value);
  await field.press("Enter");
}

/** Drags a connection on the canvas from one node's port to another's, as a person would. */
async function wire(page: Page, from: [string, string], to: [string, string]): Promise<void> {
  // Let any pan animation finish, then fit the whole graph in view.
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: /fit view/i }).click();
  await page.waitForTimeout(150);
  const handle = (node: string, port: string, side: "source" | "target") =>
    page.locator(`[data-testid="graph-node"][data-name="${node}"] .react-flow__handle.${side}[data-handleid="${port}"]`);
  const source = (await handle(from[0], from[1], "source").boundingBox())!;
  const target = (await handle(to[0], to[1], "target").boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
}

test("tutorial: build an app by hand", async ({ page }) => {
  await start(page, "by-hand");
  await expectStep(page, "blank");
  await expect(tutorial(page).getByTestId("tutorial-progress")).toHaveText("0/9");
  // "Show me" points at the control.
  await tutorial(page).getByTestId("tutorial-show-me").click();
  await expect(page.getByTestId("tutorial-highlight")).toBeVisible();
  await shot(page, "hand-01-start");

  // 1. Blank application.
  await page.getByTestId("new-app").click();
  await page.getByRole("menuitem", { name: /^Blank application/ }).click();
  await expectStep(page, "window");

  // 2–3. A window with a title.
  await page.getByTestId("library-ui.window").click();
  await expectStep(page, "title");
  await setProperty(page, "prop-title", "Shopping list");
  await expectStep(page, "collection");

  // 4. A collection of clasp.task records.
  await page.getByTestId("library-data.collection").click();
  await page.getByTestId("object-inspector").locator("#prop-schema").selectOption("clasp.task");
  await expectStep(page, "form");
  await shot(page, "hand-02-collection");

  // 5–6. A form with a text box and a button.
  await select(page, "Window");
  await page.getByTestId("library-ui.form").click();
  await page.getByTestId("library-ui.textInput").click();
  await setProperty(page, "prop-field", "title");
  await setProperty(page, "prop-placeholder", "What do you need?");
  await expectStep(page, "button");
  await page.getByTestId("library-ui.button").click();
  await setProperty(page, "prop-label", "Add");
  await expectStep(page, "wire");

  // 7. Wiring on the canvas.
  await wire(page, ["Button", "click"], ["Form", "submit"]);
  await wire(page, ["Form", "submitted"], ["Collection", "create"]);
  await expectStep(page, "list");
  await shot(page, "hand-03-wired");

  // 8. A list showing the records.
  await select(page, "Window");
  await page.getByTestId("library-ui.list").click();
  await page.getByTestId("object-inspector").locator("#prop-checkField").fill("completed");
  await page.getByTestId("object-inspector").locator("#prop-checkField").press("Enter");
  await wire(page, ["Collection", "records"], ["List", "items"]);
  await expectStep(page, "use");

  // 9. Use it.
  await mode(page, "Use");
  const app = win(page, "Untitled app");
  await expect(app.getByTestId("window-title")).toHaveText("Shopping list");
  await app.getByPlaceholder("What do you need?").fill("Milk");
  await app.getByRole("button", { name: "Add", exact: true }).click();
  await expect(part(app, "List")).toContainText("Milk");
  await expectStep(page, "finished");
  await expect(page.getByTestId("tutorial-finished")).toContainText("You built an application by hand");
  await shot(page, "hand-04-done");

  // Progress survives a reload; Finish ends the tutorial.
  await page.reload();
  await expectStep(page, "finished");
  await page.getByTestId("tutorial-finished").getByRole("button", { name: "Finish" }).click();
  await expect(tutorial(page)).toHaveCount(0);
});

test("tutorial: build an app with AI (scripted provider — not an AI)", async ({ page }) => {
  await start(page, "with-ai");
  await expectStep(page, "start");
  await shot(page, "ai-01-start");

  // 1. Describe with AI: a blank app and the AI panel.
  await page.getByTestId("new-app").click();
  await page.getByRole("menuitem", { name: /Describe with AI/ }).click();
  await expectStep(page, "describe");

  // 2. Describe it (the scripted provider stands in for a model here).
  const panel = page.getByTestId("ai-panel");
  await panel.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("ai-provider").selectOption("scripted");
  await panel.getByRole("button", { name: "Done" }).click();
  const request = await tutorial(page).getByTestId("tutorial-example").textContent();
  await page.getByTestId("ai-input").fill(request!);
  await page.getByTestId("ai-send").click();
  await expectStep(page, "review");
  await shot(page, "ai-02-proposal");

  // 3. Apply.
  await page.getByTestId("ai-apply").click();
  await expectStep(page, "use");

  // 4. Use it.
  await mode(page, "Use");
  const app = win(page, "Recipe Box");
  await expect(app.getByTestId("window-title")).toHaveText("Recipe Box");
  await app.getByPlaceholder("Recipe title").fill("Tomato soup");
  await app.getByRole("checkbox", { name: "Vegetarian" }).click();
  await app.getByRole("button", { name: "Add Recipe" }).click();
  await expect(part(app, "Recipe list")).toContainText("Tomato soup");
  await expectStep(page, "change");
  await shot(page, "ai-03-using");

  // 5. Change it by asking.
  const change = await tutorial(page).getByTestId("tutorial-example").textContent();
  await page.getByTestId("ai-input").fill(change!);
  await page.getByTestId("ai-send").click();
  await expect(page.getByTestId("ai-apply")).toHaveCount(1);
  await page.getByTestId("ai-apply").click();
  await expect(app).toContainText("1 vegetarian recipes");
  await expect(part(app, "Recipe list")).toContainText("Tomato soup"); // data kept
  await expectStep(page, "inside");

  // 6. Under the hood.
  await mode(page, "Build");
  await expectStep(page, "finished");
  await expect(page.getByTestId("tutorial-finished")).toContainText("You built and changed an application by describing it");
  await shot(page, "ai-04-graph");
});
