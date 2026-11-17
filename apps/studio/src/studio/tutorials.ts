import type { ClaspGraph, ClaspObject } from "@clasp/core";
import type { AppHandle } from "@clasp/runtime";
import type { StudioSession } from "./session";

/** What a tutorial step can look at to decide whether it is done. */
export interface TutorialContext {
  studio: StudioSession;
  /** The application this tutorial run is about: the first one created after it started. */
  app: AppHandle | undefined;
}

export interface TutorialStep {
  id: string;
  title: string;
  /** Instructions. `**bold**` marks names of things to click or type. */
  body: string;
  /** Text the learner can copy into a field, shown with a Copy button. */
  example?: string;
  /** CSS selector of the control "Show me" points at. */
  target?: string;
  /** Done when this returns true. Evaluated live against the workspace. */
  done(context: TutorialContext): boolean;
}

export interface Tutorial {
  id: "by-hand" | "with-ai";
  title: string;
  summary: string;
  minutes: number;
  finished: string;
  steps: TutorialStep[];
}

// ── helpers over the tutorial app's graph ──────────────────────────────────

function objects(app: AppHandle | undefined, type?: string): ClaspObject[] {
  if (!app) return [];
  return Object.values(app.store.graph.objects).filter((object) => type === undefined || object.type === type);
}

function inside(graph: ClaspGraph, object: ClaspObject, containerId: string): boolean {
  for (let parent = object.parentId; parent; parent = graph.objects[parent]?.parentId) if (parent === containerId) return true;
  return false;
}

function connected(app: AppHandle | undefined, from: { type: string; port: string }, to: { type: string; port: string }): boolean {
  if (!app) return false;
  const graph = app.store.graph;
  return Object.values(graph.connections).some(
    (connection) =>
      graph.objects[connection.source.objectId]?.type === from.type &&
      connection.source.port === from.port &&
      graph.objects[connection.target.objectId]?.type === to.type &&
      connection.target.port === to.port,
  );
}

function records(context: TutorialContext): number {
  const workspace = context.studio.workspace;
  if (!workspace) return 0;
  return objects(context.app, "data.collection").reduce((total, collection) => total + workspace.kernel.data.count(collection.id), 0);
}

function applied(context: TutorialContext): number {
  if (!context.app) return 0;
  return context.studio.aiThreads.get(context.app.id).entries.filter((entry) => entry.kind === "proposal" && entry.state === "applied").length;
}

// ── the tutorials ──────────────────────────────────────────────────────────

const byHand: Tutorial = {
  id: "by-hand",
  title: "Build an app by hand",
  summary: "Make a shopping list from components: a window, a form, a list and the data behind them — and wire them together.",
  minutes: 8,
  finished:
    "You built an application by hand. Everything you made is a graph of components; Use mode runs it, Build mode is where you change it. Export it from the top bar to share it.",
  steps: [
    {
      id: "blank",
      title: "Create a blank application",
      body: "Click **+** next to Applications and choose **Blank application**. It opens in Build mode: the component library on the left, the canvas in the middle, the inspector on the right.",
      target: '[data-testid="new-app"]',
      done: ({ app }) => app !== undefined,
    },
    {
      id: "window",
      title: "Add a window",
      body: "In the component library, click **Window**. Everything people see goes inside a window.",
      target: '[data-testid="library-ui.window"]',
      done: ({ app }) => objects(app, "ui.window").length > 0,
    },
    {
      id: "title",
      title: "Give it a title",
      body: "With the window selected, type a title into **Title** in the inspector on the right, then press Enter.",
      example: "Shopping list",
      target: '[data-testid="object-inspector"] #prop-title',
      done: ({ app }) => objects(app, "ui.window").some((window) => typeof window.properties.title === "string" && window.properties.title.trim() !== ""),
    },
    {
      id: "collection",
      title: "Add a place to keep the items",
      body: "Click **Collection** (under Data). In the inspector, set **Schema** to **Task (clasp.task)** — records with a title and a completed flag. Collections keep their records even when you change the app.",
      target: '[data-testid="library-data.collection"]',
      done: ({ app }) => objects(app, "data.collection").some((collection) => collection.properties.schema === "clasp.task"),
    },
    {
      id: "form",
      title: "Add a form with a text box",
      body: "Select the **Window** (click it on the canvas or in Outline), then click **Form**, then **Text input** — it goes inside the form. In the inspector set the text input's **Field name** to **title**.",
      example: "title",
      target: '[data-testid="library-ui.form"]',
      done: ({ app }) => {
        if (!app) return false;
        const graph = app.store.graph;
        return objects(app, "ui.form").some((form) => objects(app, "ui.textInput").some((input) => input.properties.field === "title" && inside(graph, input, form.id)));
      },
    },
    {
      id: "button",
      title: "Add a button",
      body: "With the text input still selected, click **Button** — it lands in the same form. Set its **Label** to **Add**.",
      example: "Add",
      target: '[data-testid="library-ui.button"]',
      done: ({ app }) => {
        if (!app) return false;
        const graph = app.store.graph;
        return objects(app, "ui.form").some((form) => objects(app, "ui.button").some((button) => inside(graph, button, form.id)));
      },
    },
    {
      id: "wire",
      title: "Wire it up",
      body: "On the canvas, drag from the Button's **click** to the Form's **submit**, then from the Form's **submitted** to the Collection's **create**. Square purple handles are events that trigger actions; round ones carry values.",
      target: '[data-testid="graph-canvas"]',
      done: ({ app }) =>
        connected(app, { type: "ui.button", port: "click" }, { type: "ui.form", port: "submit" }) &&
        connected(app, { type: "ui.form", port: "submitted" }, { type: "data.collection", port: "create" }),
    },
    {
      id: "list",
      title: "Show the items",
      body: "Select the **Window** and click **List**. Then drag the Collection's **records** to the List's **items**. To tick items off, set the list's **Checkbox field** to **completed**.",
      target: '[data-testid="library-ui.list"]',
      done: ({ app }) => connected(app, { type: "data.collection", port: "records" }, { type: "ui.list", port: "items" }),
    },
    {
      id: "use",
      title: "Use it",
      body: "Switch to **Use** at the top. Type something into your text box and press **Add**. Your app is running — no code was written.",
      target: '[role="tablist"][aria-label="Mode"]',
      done: (context) => records(context) > 0,
    },
  ],
};

const withAi: Tutorial = {
  id: "with-ai",
  title: "Build an app with AI",
  summary: "Describe a recipe box in plain words, review what the AI proposes, use the app, then change it by asking.",
  minutes: 4,
  finished:
    "You built and changed an application by describing it. The AI only ever proposes; you approved each change, and every change is undoable. Everything it made is ordinary components you can edit by hand.",
  steps: [
    {
      id: "start",
      title: "Start an app with AI",
      body: "Click **+** next to Applications and choose **Describe with AI**. A new, empty application opens with the AI panel beside it.",
      target: '[data-testid="new-app"]',
      done: ({ app, studio }) => app !== undefined && studio.aiOpen,
    },
    {
      id: "describe",
      title: "Describe what you want",
      body: "Describe the app by what it does — not how. Paste this into the AI panel and press **Propose**. No local model running? Open **Settings** in the panel and pick the **Scripted demo provider** (not an AI): it knows this request.",
      example: "A recipe box where I can add recipes with servings and whether they are vegetarian, search them, and filter to vegetarian ones.",
      target: '[data-testid="ai-input"]',
      done: ({ app, studio }) => app !== undefined && studio.aiThreads.get(app.id).entries.some((entry) => entry.kind === "proposal"),
    },
    {
      id: "review",
      title: "Review and apply",
      body: "The proposal lists the features it will build, with the underlying changes one click away. Nothing has happened yet. Click **Apply changes**.",
      target: '[data-testid="ai-apply"]',
      done: (context) => applied(context) >= 1,
    },
    {
      id: "use",
      title: "Use your app",
      body: "Switch to **Use**. Add a recipe or two, tick **Vegetarian** on one, then try the search box and the **Vegetarian** tab.",
      target: '[role="tablist"][aria-label="Mode"]',
      done: (context) => records(context) > 0,
    },
    {
      id: "change",
      title: "Change it by asking",
      body: "Ask for something more, then apply it. Your recipes stay exactly as they are.",
      example: "Add a count of vegetarian recipes.",
      target: '[data-testid="ai-input"]',
      done: (context) => applied(context) >= 2,
    },
    {
      id: "inside",
      title: "Look under the hood",
      body: "Switch to **Build**. Every box is a component and every line a connection — the same graph the AI assembled, which you can now edit by hand.",
      target: '[role="tablist"][aria-label="Mode"]',
      done: ({ app, studio }) => app !== undefined && studio.mode === "build" && studio.app?.id === app.id,
    },
  ],
};

export const TUTORIALS: readonly Tutorial[] = [withAi, byHand];

export function tutorialById(id: string | undefined): Tutorial | undefined {
  return TUTORIALS.find((tutorial) => tutorial.id === id);
}
