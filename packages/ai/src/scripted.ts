import { ClaspError } from "@clasp/core";
import type { GraphPlan } from "./plan";
import type { AIProvider, CompletionRequest, ProviderStatus } from "./provider";

export interface ScriptContext {
  /** The user's request text. */
  request: string;
  /** The full user prompt, including the description of the current application. */
  prompt: string;
  /** 1 for the first reply, 2 after one rejection, and so on. */
  attempt: number;
}

export interface Script {
  name: string;
  match(request: string): boolean;
  respond(context: ScriptContext): GraphPlan | string;
}

const createTaskManager: Script = {
  name: "Create a simple task manager",
  match: (request) => /task manager/i.test(request) && /(create|build|make|new)/i.test(request),
  respond: () => ({
    summary: "A task manager: add tasks by title and tick them off in a list.",
    title: "Task Manager",
    features: [
      { kind: "add", entity: "Task", fields: ["title"], button: "Add Task" },
      { kind: "list", entity: "Task", toggle: "completed" },
    ],
    operations: [],
  }),
};

const addIncompleteFilter: Script = {
  name: "Add a filter to show only incomplete tasks",
  match: (request) => /filter/i.test(request) && /(incomplete|unfinished|not completed|active|open)/i.test(request),
  respond: () => ({
    summary: "Shows only incomplete tasks.",
    features: [{ kind: "filter", entity: "Task", field: "completed", value: false, name: "Incomplete filter" }],
    operations: [],
  }),
};

const calendarApp: Script = {
  name: "Make a calendar app",
  match: (request) => /calendar/i.test(request),
  // No "app" field on purpose: whether this is a new application is decided from the request.
  respond: () => ({
    summary: "A calendar of events with a month view.",
    title: "Calendar",
    features: [
      { kind: "add", entity: "Event", fields: ["title", "start", "location"], button: "Add event" },
      { kind: "calendar", entity: "Event", field: "start" },
      { kind: "list", entity: "Event", fields: ["title", "start"] },
    ],
    operations: [],
  }),
};

const vegetarianCount: Script = {
  name: "Add a count of vegetarian recipes",
  match: (request) => /vegetarian/i.test(request) && /\b(count|how many|number of)\b/i.test(request),
  respond: () => ({
    summary: "Shows how many vegetarian recipes there are.",
    app: "current",
    features: [{ kind: "count", entity: "Recipe", label: "vegetarian recipes", where: { field: "vegetarian", value: true } }],
    operations: [],
  }),
};

const recipeBox: Script = {
  name: "Build a recipe box",
  match: (request) => /recipe/i.test(request),
  respond: () => ({
    summary: "A recipe box with search and a vegetarian filter.",
    title: "Recipe Box",
    entities: [
      {
        name: "Recipe",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "servings", type: "number" },
          { name: "vegetarian", type: "boolean" },
        ],
      },
    ],
    features: [
      { kind: "add", entity: "Recipe" },
      { kind: "list", entity: "Recipe" },
      { kind: "search", entity: "Recipe", field: "title" },
      { kind: "filter", entity: "Recipe", field: "vegetarian" },
      { kind: "count", entity: "Recipe", label: "recipes" },
    ],
    operations: [],
  }),
};

/** The requests of the AI generation demonstration. */
export const DEMO_SCRIPTS: readonly Script[] = [createTaskManager, addIncompleteFilter, calendarApp, vegetarianCount, recipeBox];

/**
 * A deterministic stand-in for a language model: it answers a fixed set of
 * requests with predefined plans, and nothing else.
 *
 * It exists so the proposal → validation → approval pipeline can be exercised
 * in automated tests and on machines without a local model. It performs no
 * inference and is labelled accordingly everywhere it appears.
 */
export class ScriptedProvider implements AIProvider {
  readonly id = "scripted";
  readonly label = "Scripted demo provider (not an AI)";
  readonly kind = "scripted" as const;

  constructor(private readonly scripts: readonly Script[] = DEMO_SCRIPTS) {}

  async status(): Promise<ProviderStatus> {
    return { available: true, models: ["scripted"], model: "scripted" };
  }

  /** The requests this provider can answer. */
  supportedRequests(): string[] {
    return this.scripts.map((script) => script.name);
  }

  async complete(request: CompletionRequest): Promise<string> {
    const prompt = request.messages.find((message) => message.role === "user")?.content ?? "";
    const text = /REQUEST:\s*([\s\S]*)$/.exec(prompt)?.[1]?.trim() ?? prompt.trim();
    const attempt = request.messages.filter((message) => message.role === "assistant").length + 1;
    const script = this.scripts.find((candidate) => candidate.match(text));
    if (!script) {
      throw new ClaspError(
        "UNAVAILABLE",
        `The scripted demo provider is not an AI and only understands these requests: ${this.supportedRequests()
          .map((name) => `"${name}"`)
          .join(", ")}. Start Ollama to generate anything else.`,
      );
    }
    const reply = script.respond({ request: text, prompt, attempt });
    return typeof reply === "string" ? reply : JSON.stringify(reply);
  }
}
