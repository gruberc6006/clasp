#!/usr/bin/env node
/**
 * Records a guided tour of the Clasp Studio as an MP4.
 *
 *   pnpm dev                       # the Studio, on http://localhost:5173
 *   pnpm demo:video                # writes media/clasp-demo.mp4
 *
 * It drives a fresh browser profile (so a fresh workspace) through the real
 * Studio. The AI scene uses your local Ollama model (CLASP_OLLAMA_MODEL,
 * default qwen2.5-coder:14b) — real inference, nothing scripted. Captions, a
 * visible cursor and click ripples are added to the recording only.
 * Needs ffmpeg for the conversion.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const URL = process.env.CLASP_URL ?? "http://localhost:5173";
const MODEL = process.env.CLASP_OLLAMA_MODEL ?? "qwen2.5-coder:14b";
const OUT_DIR = resolve(process.env.CLASP_DEMO_DIR ?? "media");
const WIDTH = 1440;
const HEIGHT = 900;

// ── overlay: cursor, ripples, captions, title cards ─────────────────────────
function overlay() {
  const install = () => {
    if (document.getElementById("demo-cursor")) return;
    const style = document.createElement("style");
    style.textContent = `
      #demo-cursor { position: fixed; z-index: 2147483647; pointer-events: none; left: -40px; top: -40px; width: 26px; height: 26px; filter: drop-shadow(0 2px 3px rgb(0 0 0 / .35)); }
      .demo-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; border: 3px solid #6c47ff; animation: demo-ripple .5s ease-out forwards; }
      @keyframes demo-ripple { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }
      #demo-caption { position: fixed; z-index: 2147483645; left: 50%; bottom: 92px; transform: translateX(-50%) translateY(12px); opacity: 0; pointer-events: none;
        max-width: 880px; padding: 14px 22px; border-radius: 16px; background: rgb(20 19 22 / .88); color: white; text-align: center;
        font: 600 22px/1.3 ui-sans-serif, system-ui, -apple-system, sans-serif; letter-spacing: -.01em; box-shadow: 0 18px 50px -12px rgb(0 0 0 / .5);
        transition: opacity .35s ease, transform .35s ease; backdrop-filter: blur(8px); }
      #demo-caption.on { opacity: 1; transform: translateX(-50%) translateY(0); }
      #demo-caption small { display: block; margin-top: 4px; font-weight: 400; font-size: 15px; color: rgb(255 255 255 / .72); }
      #demo-card { position: fixed; inset: 0; z-index: 2147483644; display: grid; place-items: center; text-align: center; color: white;
        background: radial-gradient(circle at 30% 20%, #7b5cff 0%, transparent 45%), radial-gradient(circle at 80% 90%, #ff8a65 0%, transparent 40%), #141316;
        font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; opacity: 0; transition: opacity .6s ease; }
      #demo-card.on { opacity: 1; }
      #demo-card h1 { margin: 0; font-size: 96px; font-weight: 700; letter-spacing: -.04em; }
      #demo-card h1 span { color: #a48bff; }
      #demo-card p { margin: 10px 0 0; font-size: 28px; color: rgb(255 255 255 / .85); }
      #demo-card ul { margin: 34px 0 0; padding: 0; list-style: none; font-size: 19px; color: rgb(255 255 255 / .7); line-height: 1.8; }`;
    document.head.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2l16 9.5-7 1.6 4.2 7.4-3 1.6-4.1-7.4L5 19.5z" fill="white" stroke="#141316" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cursor);
    const caption = document.createElement("div");
    caption.id = "demo-caption";
    document.body.appendChild(caption);
    window.__demoCursor = cursor;
    if (window.__demoLast) {
      cursor.style.left = `${window.__demoLast.x}px`;
      cursor.style.top = `${window.__demoLast.y}px`;
    }
  };
  document.addEventListener(
    "mousemove",
    (event) => {
      window.__demoLast = { x: event.clientX, y: event.clientY };
      const cursor = document.getElementById("demo-cursor");
      if (cursor) {
        cursor.style.left = `${event.clientX - 3}px`;
        cursor.style.top = `${event.clientY - 2}px`;
      }
    },
    true,
  );
  document.addEventListener(
    "mousedown",
    (event) => {
      const ripple = document.createElement("div");
      ripple.className = "demo-ripple";
      ripple.style.left = `${event.clientX}px`;
      ripple.style.top = `${event.clientY}px`;
      document.body.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
    },
    true,
  );
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
  window.__caption = (text, sub) => {
    const caption = document.getElementById("demo-caption");
    if (!caption) return;
    if (!text) {
      caption.classList.remove("on");
      return;
    }
    caption.innerHTML = "";
    caption.append(document.createTextNode(text));
    if (sub) {
      const small = document.createElement("small");
      small.textContent = sub;
      caption.append(small);
    }
    caption.classList.add("on");
  };
  window.__card = (title, subtitle, lines) => {
    let card = document.getElementById("demo-card");
    if (!title) {
      card?.classList.remove("on");
      setTimeout(() => card?.remove(), 700);
      return;
    }
    card = document.createElement("div");
    card.id = "demo-card";
    const inner = document.createElement("div");
    const h1 = document.createElement("h1");
    h1.innerHTML = title;
    const p = document.createElement("p");
    p.textContent = subtitle;
    inner.append(h1, p);
    if (lines?.length) {
      const ul = document.createElement("ul");
      for (const line of lines) {
        const li = document.createElement("li");
        li.textContent = line;
        ul.append(li);
      }
      inner.append(ul);
    }
    card.append(inner);
    document.body.appendChild(card);
    requestAnimationFrame(() => card.classList.add("on"));
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let page;
/** Moments in the recording (seconds from its start), for editing it afterwards. */
const marks = {};
let started = 0;
const mark = (name) => (marks[name] = (Date.now() - started) / 1000);
let mouse = { x: WIDTH / 2, y: HEIGHT / 2 };

async function caption(text, sub) {
  await page.evaluate(([t, s]) => window.__caption?.(t, s), [text ?? "", sub ?? ""]);
}
async function card(title, subtitle, lines, ms) {
  await page.evaluate(([t, s, l]) => window.__card?.(t, s, l), [title, subtitle, lines]);
  await sleep(ms);
  await page.evaluate(() => window.__card?.(""));
  await sleep(700);
}
async function moveTo(locator) {
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const distance = Math.hypot(target.x - mouse.x, target.y - mouse.y);
  await page.mouse.move(target.x, target.y, { steps: Math.max(8, Math.min(40, Math.round(distance / 22))) });
  mouse = target;
  await sleep(140);
  return target;
}
async function click(locator) {
  await moveTo(locator);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
  await sleep(320);
}
async function type(locator, text, delay = 38) {
  await click(locator);
  await locator.pressSequentially(text, { delay });
  await sleep(250);
}
async function press(key, times = 1, gap = 120) {
  for (let index = 0; index < times; index++) {
    await page.keyboard.press(key);
    await sleep(gap);
  }
}
async function drag(locator, dx, dy) {
  const from = await moveTo(locator);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 30 });
  mouse = { x: from.x + dx, y: from.y + dy };
  await page.mouse.up();
  await sleep(300);
}
const win = (name) => page.locator(`[data-testid="window"][data-app-name="${name}"]`);
const part = (scope, name) => scope.locator(`[data-clasp-name="${name}"]`);
async function fromTemplate(name) {
  await click(page.getByTestId("new-app"));
  await click(page.getByRole("menuitem", { name: /From a template/ }));
  await sleep(500);
  await click(page.getByTestId("template-gallery").getByRole("button", { name, exact: true }));
  await sleep(700);
}

// ── the tour ─────────────────────────────────────────────────────────────────
async function tour() {
  await page.goto(URL);
  await page.getByTestId("app-title").waitFor();
  await sleep(600);

  mark("intro");
  await card('clasp<span>.</span>', "Build anything. Connect everything.", ["A local-first computing platform that runs in your browser", "Apps are graphs of safe components · AI proposes, you approve"], 4200);

  // 1. The desktop
  await caption("Every app runs in its own window on a desktop", "Task Manager and Task Dashboard come with every new workspace");
  const manager = win("Task Manager");
  for (const title of ["Plan the launch", "Record a demo", "Write the docs"]) {
    await type(manager.getByPlaceholder("What needs to be done?"), title);
    await click(manager.getByRole("button", { name: "Add task" }));
  }
  await click(manager.getByRole("checkbox", { name: "Mark complete: Record a demo" }));
  await drag(manager.getByTestId("window-title"), 40, 18);
  await sleep(600);

  // 2. Permissions
  await caption("Apps share nothing until you allow it", "The dashboard can find the tasks, but must ask before it reads them");
  const dashboard = win("Task Dashboard");
  await click(page.getByTestId("app-list").getByRole("button", { name: "Task Dashboard", exact: true }));
  await click(part(dashboard, "Available sources").locator("li").first());
  await click(dashboard.getByRole("button", { name: "Request read access" }));
  await sleep(1800);
  await click(page.getByTestId("permission-allow"));
  await caption("Allowed — and now it is live", "Changes in Task Manager appear in the dashboard straight away");
  await click(page.getByTestId("app-list").getByRole("button", { name: "Task Manager", exact: true }));
  await type(manager.getByPlaceholder("What needs to be done?"), "Ship it");
  await click(manager.getByRole("button", { name: "Add task" }));
  await sleep(1800);

  // 3. Templates
  await caption("23 ready-made apps: documents, tools and games", "Each one is an ordinary graph you can open up and change");
  await click(page.getByTestId("new-app"));
  await click(page.getByRole("menuitem", { name: /From a template/ }));
  await sleep(2200);
  await click(page.getByTestId("template-gallery").getByRole("button", { name: "Calculator", exact: true }));
  await sleep(700);
  const calc = win("Calculator");
  await click(part(calc, "Calculator"));
  for (const key of "12*(3+4)") await press(key, 1, 140);
  await press("Enter");
  await sleep(1200);

  await caption("A word processor that shows the page as you type");
  await fromTemplate("Word Processor");
  const writer = win("Word Processor");
  await type(writer.getByLabel("Text"), "# Launch notes\n\nClasp is **local-first**: your data stays *on this computer*.\n\n- Apps are graphs of components\n- AI proposes, you approve\n", 22);
  await sleep(1200);

  await caption("And a few games, each with a high-score list");
  await fromTemplate("Glowworm");
  const worm = win("Glowworm");
  await click(part(worm, "Game"));
  await press("ArrowUp", 1, 700);
  await press("ArrowRight", 1, 600);
  await press("ArrowDown", 1, 900);
  await press("ArrowLeft", 1, 700);
  await press("ArrowUp", 1, 800);
  await press(" ");
  await sleep(600);
  await click(worm.getByRole("button", { name: "Minimize window" }));
  await click(writer.getByRole("button", { name: "Minimize window" }));
  await click(calc.getByRole("button", { name: "Minimize window" }));

  // 4. Features panel
  await caption("Build an app feature by feature — no wiring", "Start blank, name it, then say what it keeps and what it does");
  await click(page.getByTestId("new-app"));
  await click(page.getByRole("menuitem", { name: /^Blank application/ }));
  await sleep(500);
  await click(page.getByRole("tab", { name: "Use", exact: true }));
  await click(page.getByTestId("app-title-button"));
  await page.getByTestId("rename-input").press("ControlOrMeta+a");
  await page.getByTestId("rename-input").pressSequentially("Reading List", { delay: 45 });
  await press("Enter");
  await click(page.getByTestId("features-toggle"));
  const panel = page.getByTestId("feature-panel");
  await click(panel.getByTestId("feature-add"));
  await sleep(700);
  await click(panel.getByTestId("feature-kind-records"));
  await type(panel.getByTestId("records-name"), "Book");
  await click(panel.getByRole("button", { name: "+ Another field" }));
  await type(panel.getByLabel("Field 2 name"), "author");
  await click(panel.getByRole("button", { name: "+ Another field" }));
  await type(panel.getByLabel("Field 3 name"), "finished");
  await panel.getByLabel("Field 3 type").selectOption("boolean");
  await sleep(1500);
  await click(panel.getByTestId("feature-apply"));
  const books = win("Reading List");
  for (const [title, author] of [["Dune", "Frank Herbert"], ["Middlemarch", "George Eliot"], ["Emma", "Jane Austen"]]) {
    await type(books.getByPlaceholder("Book title"), title, 30);
    await type(books.getByPlaceholder("Book author"), author, 30);
    await click(books.getByRole("button", { name: "Add Book" }));
  }
  await caption("Add a search — the panel shows what will happen first");
  await click(panel.getByTestId("feature-add"));
  await click(panel.getByTestId("feature-kind-search"));
  await sleep(1400);
  await click(panel.getByTestId("feature-apply"));
  await type(books.getByPlaceholder("Search books…"), "mid", 90);
  await sleep(1500);
  await click(panel.getByRole("button", { name: "Close features" }));

  // 5. AI
  await caption("Or describe it — a local model proposes, you approve", `Real inference with ${MODEL} through Ollama, on this computer. No generated code ever runs.`);
  await click(page.getByTestId("new-app"));
  await click(page.getByRole("menuitem", { name: /Describe with AI/ }));
  await sleep(600);
  await type(page.getByTestId("ai-input"), "A recipe box where I can add recipes with servings and whether they are vegetarian, search them, and filter to vegetarian ones.", 16);
  await click(page.getByTestId("ai-send"));
  await sleep(1500);
  await caption("The model is working it out…", "Sped up in this video — a local model takes a little while");
  mark("thinking");
  await page.getByTestId("ai-apply").waitFor({ state: "visible", timeout: 240_000 });
  mark("answered");
  await caption("The proposal is a list of features", "Nothing has changed yet — apply it, or discard it");
  await moveTo(page.getByTestId("ai-features"));
  await sleep(3000);
  await click(page.getByTestId("ai-apply"));
  await sleep(600);
  await click(page.getByRole("tab", { name: "Use", exact: true }));
  await click(page.getByRole("button", { name: "Close AI panel" }));
  const appName = (await page.getByTestId("app-title").textContent())?.trim() ?? "Recipe Box";
  const recipes = win(appName);
  await type(recipes.getByRole("textbox").first(), "Tomato soup", 35);
  const vegetarian = recipes.getByRole("checkbox").first();
  if (await vegetarian.count()) await click(vegetarian);
  await click(recipes.getByRole("button", { name: /^Add/ }).first());
  await sleep(1200);

  // 6. Build mode
  await caption("Under the hood: the same app as a graph", "Every box is a component, every line a connection — edit it by hand if you like");
  await click(page.getByRole("tab", { name: "Build", exact: true }));
  await sleep(800);
  const fit = page.getByRole("button", { name: /fit view/i });
  if (await fit.count()) await click(fit);
  await sleep(3200);
  await click(page.getByRole("tab", { name: "Use", exact: true }));

  // 7. Appearance
  await caption("Make it yours", "Light or dark, an accent colour, and a desktop background");
  await click(page.getByTestId("nav-appearance"));
  await sleep(500);
  const look = page.getByTestId("appearance");
  await click(look.getByTestId("theme-dark"));
  await sleep(500);
  await click(look.getByTestId("accent-teal"));
  await sleep(400);
  await click(look.getByTestId("background-dusk"));
  await sleep(900);
  await press("Escape");
  await sleep(2600);
  await caption("");

  await card('clasp<span>.</span>', "github.com/gruberc6006/clasp", ["MIT licensed · local-first · no accounts, no cloud", "TypeScript · React · Ollama"], 4500);
}

// ── record ───────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
const raw = join(OUT_DIR, "raw");
rmSync(raw, { recursive: true, force: true });
const browser = await chromium.launch({ channel: process.env.CLASP_E2E_CHANNEL ?? "chrome" });
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  recordVideo: { dir: raw, size: { width: WIDTH, height: HEIGHT } },
  colorScheme: "light",
});
await context.addInitScript(overlay);
await context.addInitScript(([model]) => {
  localStorage.setItem("clasp.ai.v1", JSON.stringify({ provider: "ollama", baseUrl: "http://localhost:11434", model }));
}, [MODEL]);
page = await context.newPage();
started = Date.now();
try {
  await tour();
} finally {
  await context.close();
  await browser.close();
}
const [video] = readdirSync(raw).filter((name) => name.endsWith(".webm"));
const output = join(OUT_DIR, "clasp-demo.mp4");
// Start at the title card, and fast-forward through the model's thinking (to about 5 seconds).
const start = Math.max(0, (marks.intro ?? 0) + 0.3);
const from = marks.thinking ?? 0;
const to = marks.answered ?? 0;
const factor = Math.max(1, (to - from) / 5);
const filter =
  factor > 1.5
    ? `[0:v]trim=start=${start}:end=${from},setpts=PTS-STARTPTS[a];[0:v]trim=start=${from}:end=${to},setpts=(PTS-STARTPTS)/${factor.toFixed(2)}[b];[0:v]trim=start=${to},setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0[out]`
    : `[0:v]trim=start=${start},setpts=PTS-STARTPTS[out]`;
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(raw, video), "-filter_complex", filter, "-map", "[out]", "-r", "30", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output]);
console.log(`The model took ${(to - from + 1.5).toFixed(0)} s; that part is shown ${factor.toFixed(1)}× faster.`);
rmSync(raw, { recursive: true, force: true });
console.log(`Wrote ${output}`);
