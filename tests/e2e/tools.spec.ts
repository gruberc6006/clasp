import { expect, fromTemplate, mode, part, test, win } from "./helpers";

/** Templates added beside the two applications every new workspace starts with. */
const NEW_TEMPLATES = [
  "Notes",
  "Spreadsheet",
  "Sketchpad",
  "Calendar",
  "Beat Maker",
  "Word Processor",
  "Text Editor",
  "Kanban Board",
  "Contacts",
  "Journal",
  "Terminal",
  "Calculator",
  "File Browser",
  "System Monitor",
  "Clock",
  "Socket Chat",
  "Tic-tac-toe",
  "Pairs",
  "Word Guess",
  "Glowworm",
  "Task Notifier",
];

test("every template in the gallery opens in its own window without errors", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("new-app").click();
  await page.getByRole("menuitem", { name: /From a template/ }).click();
  const gallery = page.getByTestId("template-gallery");
  await expect(gallery.getByTestId("template-card")).toHaveCount(23);
  await gallery.getByLabel("Search templates").fill("game");
  await expect(gallery.getByRole("region", { name: "Games" })).toBeVisible();
  await page.keyboard.press("Escape");

  for (const name of NEW_TEMPLATES) {
    await fromTemplate(page, name);
    await expect(win(page, name)).toBeVisible();
    if (name === "System Monitor") {
      // The monitor asks for its permission as soon as it starts.
      await expect(page.getByTestId("permission-prompt")).toContainText("System Monitor");
      await page.getByTestId("permission-deny").click();
      await expect(win(page, name).getByTestId("monitor-status")).toHaveAttribute("data-status", "denied");
    }
  }
});

test("Calculator, Terminal, Word Processor and Kanban Board work as people use them", async ({ page }) => {
  await page.goto("/");

  await fromTemplate(page, "Calculator");
  const calc = win(page, "Calculator");
  await part(calc, "Calculator").click();
  await page.keyboard.type("12+3*4");
  await page.keyboard.press("Enter");
  await expect(calc.getByTestId("calc-display")).toHaveText("24");
  await calc.getByRole("button", { name: "Clear" }).click();
  await expect(calc.getByTestId("calc-display")).toHaveText("0");

  await fromTemplate(page, "Terminal");
  const terminal = win(page, "Terminal");
  await terminal.getByLabel("Command").fill("calc 6*7");
  await terminal.getByLabel("Command").press("Enter");
  await expect(terminal.getByTestId("terminal-screen")).toContainText("42");
  await terminal.getByLabel("Command").fill("discover");
  await terminal.getByLabel("Command").press("Enter");
  await expect(terminal.getByTestId("terminal-screen")).toContainText("Task Manager");

  await fromTemplate(page, "Word Processor");
  const writer = win(page, "Word Processor");
  await writer.getByLabel("Text").fill("# Minutes\n\nWe agreed.");
  // Select "We agreed." and make it bold.
  await writer.getByLabel("Text").evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(11, 21));
  await writer.getByRole("button", { name: "Bold" }).click();
  await expect(writer.getByLabel("Text")).toHaveValue("# Minutes\n\n**We agreed.**");
  await expect(writer.getByTestId("page").getByRole("heading", { name: "Minutes" })).toBeVisible();
  await expect(writer.getByTestId("page").locator("strong")).toContainText("We agreed.");

  await fromTemplate(page, "Kanban Board");
  const board = win(page, "Kanban Board");
  await board.getByPlaceholder("Card title").fill("Ship it");
  await board.getByRole("button", { name: "Add card" }).click();
  const card = board.locator('[data-card="Ship it"]');
  await expect(board.locator('[data-column="To do"]')).toContainText("Ship it");
  await card.dragTo(board.locator('[data-column="Done"]'));
  await expect(board.locator('[data-column="Done"]')).toContainText("Ship it");
  await board.getByRole("button", { name: "Move Ship it left" }).click();
  await expect(board.locator('[data-column="Doing"]')).toContainText("Ship it");
});

test("File Browser lists files with permission and opens one in its application", async ({ page }) => {
  await page.goto("/");
  await fromTemplate(page, "Word Processor");
  const writer = win(page, "Word Processor");
  await writer.getByLabel("Text").fill("# Hello from a file");
  await writer.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByTestId("file-dialog-name").fill("Greeting");
  await page.getByTestId("file-dialog-confirm").click();
  await expect(writer.getByTestId("window-title")).toHaveText("Greeting");
  await writer.getByRole("button", { name: "New", exact: true }).click();
  await expect(writer.getByLabel("Text")).toHaveValue("");

  await fromTemplate(page, "File Browser");
  const browser = win(page, "File Browser");
  await expect(part(browser, "Access explanation")).toBeVisible();
  await browser.getByRole("button", { name: "Show my files" }).click();
  await expect(page.getByTestId("permission-prompt")).toContainText("File Browser");
  await page.getByTestId("permission-allow").click();
  const row = part(browser, "File table").locator("tbody tr", { hasText: "Greeting" });
  await expect(row).toContainText("richtext");

  await row.getByTestId("row-action").click();
  await expect(page.getByTestId("permission-prompt")).toContainText("Desktop");
  await page.getByTestId("permission-allow").click();
  await expect(writer.getByTestId("window-title")).toHaveText("Greeting");
  await expect(writer.getByLabel("Text")).toHaveValue("# Hello from a file");
});

test("System Monitor shows live measurements once allowed", async ({ page }) => {
  await page.goto("/");
  await fromTemplate(page, "System Monitor");
  await page.getByTestId("permission-allow").click();
  const monitor = win(page, "System Monitor");
  await expect(monitor.getByTestId("monitor-status")).toHaveAttribute("data-status", "live");
  await expect(monitor.locator('[data-metric="fps"]')).toContainText("fps");
  await expect(monitor).toContainText("Applications: 3");
});

test("games: play to the end and land on the high-score list", async ({ page }) => {
  await page.goto("/");
  await fromTemplate(page, "Tic-tac-toe");
  const ttt = win(page, "Tic-tac-toe");
  for (let move = 0; move < 5; move++) {
    const free = ttt.locator("[data-cell]:not([disabled])");
    if ((await free.count()) === 0) break;
    await free.first().click();
  }
  await expect(part(ttt, "High scores").getByText(/the computer/)).toBeVisible();

  await fromTemplate(page, "Glowworm");
  const worm = win(page, "Glowworm");
  await part(worm, "Game").click();
  await page.keyboard.press("ArrowUp");
  await expect(part(worm, "Game")).toHaveAttribute("data-state", "running");
  // Heading straight up, it reaches the wall within a couple of seconds.
  await expect(part(worm, "Game")).toHaveAttribute("data-state", "over", { timeout: 8000 });
  await expect(part(worm, "High scores")).toContainText(/Ate \d+ sparks?/);

  await fromTemplate(page, "Word Guess");
  const words = win(page, "Word Guess");
  await part(words, "Game").click();
  // Every letter: the game is certainly over, won or lost.
  for (const letter of "etaoinshrdlucmfwypvbgkjqxz") await page.keyboard.press(letter);
  await expect(words.getByTestId("game-status")).toHaveText(/You got it!|Out of lives/);
  await expect(part(words, "High scores")).toContainText(/Guessed|Missed/);

  await mode(page, "Build");
  await expect(page.getByTestId("component-library")).toContainText("Games");
});
