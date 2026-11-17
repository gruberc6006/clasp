import { registerPrimitives } from "@clasp/primitives";
import { ComponentRegistry } from "@clasp/runtime";
import { registerFiles } from "@clasp/files";
import { registerNetwork } from "@clasp/network";
import { registerWorkflows } from "@clasp/workflows";
import { buildTaskDashboard } from "./task-dashboard";
import { buildTaskManager } from "./task-manager";
import { buildTaskNotifier } from "./task-notifier";
import { buildSocketChat } from "./socket-chat";
import { DOCUMENT_APPS, documentAppTemplate } from "./document-apps";
import { GAME_TEMPLATES, TOOL_TEMPLATES, type AppTemplate, type TemplateCategory } from "./workspace-tools";

export { buildSocketChat, buildTaskDashboard, buildTaskManager, buildTaskNotifier };
export { LOCAL_SOCKET_SERVER } from "./socket-chat";
export { DOCUMENT_APPS, buildFromFeatures } from "./document-apps";
export { GAME_TEMPLATES, TOOL_TEMPLATES, buildFileBrowser, featureTemplate, type AppTemplate, type TemplateCategory } from "./workspace-tools";

/** The standard component set: built-in primitives, workflow components, documents and sockets. */
export function createStandardRegistry(): ComponentRegistry {
  return registerNetwork(registerFiles(registerWorkflows(registerPrimitives(new ComponentRegistry()))));
}

/** Order of the categories in the template gallery. */
export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = ["Productivity", "Tools", "Creative", "Games", "Examples"];

const DOCUMENT_CATEGORIES: Record<string, TemplateCategory> = {
  notes: "Productivity",
  spreadsheet: "Productivity",
  calendar: "Productivity",
  sketchpad: "Creative",
  "beat-maker": "Creative",
};

export const templates: AppTemplate[] = [
  {
    id: "task-manager",
    name: "Task Manager",
    description: "Create, edit, complete and delete tasks stored in a clasp.task collection.",
    category: "Productivity",
    build: buildTaskManager,
  },
  ...DOCUMENT_APPS.map((entry) => ({ ...documentAppTemplate(entry), category: DOCUMENT_CATEGORIES[entry.id] ?? "Productivity" })),
  ...TOOL_TEMPLATES,
  {
    id: "socket-chat",
    name: "Socket Chat",
    description: "Send and receive messages over a WebSocket. Asks you before connecting to any server.",
    category: "Tools",
    build: buildSocketChat,
  },
  ...GAME_TEMPLATES,
  {
    id: "task-dashboard",
    name: "Task Dashboard",
    description: "Discover another app's tasks, request read access and watch them live.",
    category: "Examples",
    build: buildTaskDashboard,
  },
  {
    id: "task-notifier",
    name: "Task Notifier",
    description: "A background workflow that notifies you when a task is completed.",
    category: "Examples",
    build: (catalog) => buildTaskNotifier(catalog),
  },
];
