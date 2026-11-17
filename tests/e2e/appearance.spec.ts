import { expect, test } from "./helpers";

/** A 1×1 PNG, standing in for a holiday photo. */
const PICTURE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("themes, accent colours and desktop backgrounds are chosen, applied and remembered", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const html = page.locator("html");
  const desktop = page.getByTestId("desktop");
  await expect(html).toHaveAttribute("data-theme", "light"); // Automatic follows the system

  await page.getByTestId("nav-appearance").click();
  const dialog = page.getByTestId("appearance");
  await expect(dialog).toBeVisible();

  // Automatic follows the system as it changes.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "light");

  // A fixed theme, an accent and a background.
  await dialog.getByTestId("theme-dark").click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(20, 19, 22)");
  await dialog.getByTestId("accent-rose").click();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim())).toBe("#e11d48");
  await dialog.getByTestId("background-ocean").click();
  await expect(desktop).toHaveAttribute("data-background", "ocean");

  // Your own picture.
  await dialog.getByTestId("background-file").setInputFiles({ name: "holiday.png", mimeType: "image/png", buffer: PICTURE });
  await expect(desktop).toHaveAttribute("data-background", "picture");
  expect(await desktop.evaluate((element) => element.style.backgroundImage)).toContain("data:image/jpeg");
  await page.keyboard.press("Escape");

  // Everything is still there after a reload.
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(desktop).toHaveAttribute("data-background", "picture");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim())).toBe("#e11d48");

  // Taking the picture away falls back to a preset; something that is not a picture is refused.
  await page.getByTestId("nav-appearance").click();
  await dialog.getByRole("button", { name: "Remove picture" }).click();
  await expect(desktop).toHaveAttribute("data-background", "dots");
  await dialog.getByTestId("background-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a picture") });
  await expect(page.getByTestId("toast")).toContainText("“notes.txt” is not a picture.");
  await dialog.getByTestId("theme-system").click();
  await dialog.getByTestId("accent-violet").click();
  await expect(html).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--color-accent"))).toBe("");
});
