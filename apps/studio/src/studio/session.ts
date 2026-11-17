import { DEFAULT_OLLAMA_URL, GraphAssistant, OllamaProvider, ScriptedProvider, applyProposal, type AIProvider, type ProposalTarget } from "@clasp/ai";
import { createGraph, createId, isClaspError, nowIso, toClaspError, type ClaspGraph, type GraphOperation } from "@clasp/core";
import { createStandardRegistry, templates } from "@clasp/examples";
import { IndexedDbStorage, WorkspaceStorage } from "@clasp/persistence";
import type { SchemaDefinition } from "@clasp/schemas";
import type { RenderHost } from "@clasp/renderer-react";
import { Workspace, type AppHandle } from "@clasp/runtime";
import { exportPackage, forkGraph, importPackage, packageFileName, serializePackage, type ImportResult } from "@clasp/sharing";
import { DesktopService, FileService, documentFeature, type FileDialogRequest, type FileDialogs, type FileEntry, type SaveChoice } from "@clasp/files";
import { NetworkService, webSocketFactory } from "@clasp/network";
import { NotificationCenter, SystemMetrics } from "@clasp/workflows";
import { BrowserMetrics } from "./metrics";
import { DEFAULT_APPEARANCE, normalizeAppearance, type Appearance } from "./appearance";
import { AiThreads } from "./ai-threads";
import { tutorialById, type Tutorial } from "./tutorials";
import { exportFile, importFile } from "./disk";

/** The template that opens each kind of file when no application for it exists yet. */
const APPEARANCE_KEY = "clasp.appearance";

const KIND_TEMPLATES: Record<string, string> = {
  text: "text-editor",
  richtext: "word-processor",
  spreadsheet: "spreadsheet",
  drawing: "sketchpad",
  sequencer: "beat-maker",
};

export interface WorkspaceEntry {
  id: string;
  name: string;
  createdAt: string;
}

export type Section = "apps" | "data" | "files" | "permissions";

/** A file dialog the file service asked for, waiting for the user. */
export type PendingFileDialog =
  | { mode: "open"; request: FileDialogRequest; resolve: (fileId: string | undefined) => void }
  | { mode: "save"; request: FileDialogRequest & { suggestedName: string }; resolve: (choice: SaveChoice | undefined) => void };
export type Mode = "use" | "build";
export type ToastTone = "info" | "success" | "warning" | "error";

export interface Toast {
  id: string;
  tone: ToastTone;
  title?: string;
  message: string;
}

/** Where one window sits on the desktop. Presentation state: saved per workspace, never part of a graph. */
export interface WindowState {
  x: number;
  y: number;
  width: number;
  /** Fixed height after the user resized it; otherwise the window fits its content. */
  height?: number;
  /** Stacking order; larger is in front. */
  z: number;
  minimized?: boolean;
  closed?: boolean;
  maximized?: boolean;
}

/** Desktop key of a window: one per top-level window object (or one for an app's loose elements). */
export function windowKey(appId: string, objectId: string): string {
  return `${appId}:${objectId}`;
}

export interface AiSettings {
  provider: "ollama" | "scripted";
  baseUrl: string;
  model?: string;
}

const INDEX_KEY = "clasp.workspaces.v1";
const TUTORIAL_KEY = "clasp.tutorial.v1";
const AI_KEY = "clasp.ai.v1";

interface StoredIndex {
  current: string;
  entries: WorkspaceEntry[];
}

function readJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable (private mode); the session still works in memory.
  }
}

/**
 * Everything the Studio UI needs that is not application state: which
 * workspace is open, which application and object are selected, toasts and AI
 * settings. Application definitions, data and permissions live in the
 * workspace — the Studio only ever goes through it.
 */
export class StudioSession {
  entries: WorkspaceEntry[] = [];
  currentId = "";
  status: "loading" | "ready" | "error" = "loading";
  error: string | undefined;
  workspace: Workspace | undefined;
  notifications: NotificationCenter | undefined;
  files: FileService | undefined;
  /** Sockets to hosts the user allowed. */
  network: NetworkService | undefined;
  /** Browser measurements behind the System service. */
  private readonly metrics = new BrowserMetrics(
    () => this.workspace,
    () => this.network,
  );
  fileDialog: PendingFileDialog | undefined;

  section: Section = "apps";
  mode: Mode = "use";
  selectedAppId: string | undefined;
  selectedObjectId: string | undefined;
  aiOpen = false;
  toasts: Toast[] = [];
  windows: Record<string, WindowState> = {};
  focusedWindow: string | undefined;
  /** The tutorial being followed: which one, and the apps that existed when it started. */
  tutorial: { id: Tutorial["id"]; workspaceId: string; appsBefore: string[] } | undefined = readJson(TUTORIAL_KEY);
  tutorialPickerOpen = false;
  templateGalleryOpen = false;
  appearanceOpen = false;
  /** The application whose name is being edited, and where. */
  renaming: { appId: string; where: "title" | "sidebar" } | undefined;
  /** How the Studio looks; saved with the workspace (the last one is remembered for start-up). */
  appearance: Appearance = normalizeAppearance(readJson(APPEARANCE_KEY) ?? DEFAULT_APPEARANCE);
  /** A control the tutorial is pointing at ("Show me"). */
  highlight: string | undefined;
  /** AI conversations per application; they outlive the panel. */
  readonly aiThreads: AiThreads = new AiThreads({
    bump: () => this.bump(),
    assistant: () => this.assistant(),
    app: (id) => this.workspace?.app(id),
    onUnavailable: () => this.bump(),
  });
  ai: AiSettings = { provider: "ollama", baseUrl: DEFAULT_OLLAMA_URL, ...readJson<Partial<AiSettings>>(AI_KEY) };

  private windowSave: { timer: ReturnType<typeof setTimeout>; save: () => Promise<void> } | undefined;
  private version = 0;
  private booting: Promise<void> | undefined;
  private opening: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private disposers: Array<() => void> = [];
  private recentErrors = new Map<string, number>();

  // ── subscription (for useSyncExternalStore) ─────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  bump = (): void => {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  };

  // ── workspaces ──────────────────────────────────────────────────────────

  get currentEntry(): WorkspaceEntry | undefined {
    return this.entries.find((entry) => entry.id === this.currentId);
  }

  /** Opens the last workspace (or creates the first one). Safe to call more than once. */
  boot(): Promise<void> {
    this.booting ??= this.bootOnce();
    return this.booting;
  }

  /** Starts over after a failed boot. */
  retry(): Promise<void> {
    this.booting = undefined;
    return this.boot();
  }

  private async bootOnce(): Promise<void> {
    const stored = readJson<StoredIndex>(INDEX_KEY);
    if (stored && stored.entries.length > 0) {
      this.entries = stored.entries;
      const current = stored.entries.find((entry) => entry.id === stored.current) ?? stored.entries[0];
      await this.open((current as WorkspaceEntry).id, false);
      return;
    }
    // First launch: one workspace with the two demonstration applications.
    const entry: WorkspaceEntry = { id: createId("ws"), name: "Personal", createdAt: nowIso() };
    this.entries = [entry];
    await this.open(entry.id, true);
  }

  async switchWorkspace(id: string): Promise<void> {
    if (id === this.currentId && this.status === "ready") return;
    await this.open(id, false);
  }

  async createWorkspace(name: string): Promise<void> {
    const entry: WorkspaceEntry = { id: createId("ws"), name: name.trim() || "Untitled workspace", createdAt: nowIso() };
    this.entries = [...this.entries, entry];
    await this.open(entry.id, false);
    this.toast({ tone: "success", message: `Workspace “${entry.name}” created. It starts empty.` });
  }

  async deleteWorkspace(id: string): Promise<void> {
    if (this.entries.length <= 1) {
      this.toast({ tone: "warning", message: "You need at least one workspace." });
      return;
    }
    const remaining = this.entries.filter((entry) => entry.id !== id);
    if (id === this.currentId) {
      await this.closeCurrent();
      this.entries = remaining;
      await IndexedDbStorage.destroy(id);
      await this.open((remaining[0] as WorkspaceEntry).id, false);
    } else {
      this.entries = remaining;
      await IndexedDbStorage.destroy(id);
      this.saveIndex();
      this.bump();
    }
  }

  private saveIndex(): void {
    writeJson(INDEX_KEY, { current: this.currentId, entries: this.entries } satisfies StoredIndex);
  }

  private async closeCurrent(): Promise<void> {
    await this.flushWindows();
    this.answerFileDialog(undefined);
    this.aiThreads.clear();
    for (const dispose of this.disposers.splice(0)) dispose();
    const previous = this.workspace;
    this.network?.disconnectAll();
    this.metrics.stop();
    this.workspace = undefined;
    this.notifications = undefined;
    this.network = undefined;
    if (previous) await previous.close();
  }

  /** Opens a workspace. Opens are serialized so two can never interleave. */
  private open(id: string, seed: boolean): Promise<void> {
    const run = this.opening.then(() => this.openNow(id, seed));
    this.opening = run.catch(() => undefined);
    return run;
  }

  private async openNow(id: string, seed: boolean): Promise<void> {
    this.status = "loading";
    this.error = undefined;
    this.selectedAppId = undefined;
    this.selectedObjectId = undefined;
    this.bump();
    try {
      await this.closeCurrent();
      const storage = new WorkspaceStorage(await IndexedDbStorage.open(id));
      let notifications!: NotificationCenter;
      let files!: FileService;
      let network!: NetworkService;
      const dialogs: FileDialogs = {
        open: (request) => this.askFile({ mode: "open", request }),
        save: (request) => this.askFile({ mode: "save", request }),
      };
      const workspace = await Workspace.open({
        storage,
        registry: createStandardRegistry(),
        // System services are in place before any application starts.
        setup: (opened) => {
          notifications = new NotificationCenter(opened.kernel);
          files = new FileService(opened.kernel, opened.schemas, dialogs);
          // Real WebSockets — but only to hosts the user allows, per application.
          network = new NetworkService(opened.kernel, webSocketFactory());
          new SystemMetrics(opened.kernel, () => this.metrics.sample());
          new DesktopService(opened.kernel, files, (file) => this.launchFile(file));
        },
      });
      const desktop = await storage.getMeta<{ windows?: Record<string, WindowState> }>("desktop");
      this.appearance = normalizeAppearance((await storage.getMeta<Appearance>("appearance")) ?? readJson(APPEARANCE_KEY) ?? DEFAULT_APPEARANCE);
      this.windows = desktop?.windows ?? {};
      this.focusedWindow = undefined;
      this.workspace = workspace;
      this.notifications = notifications;
      this.files = files;
      this.network = network;
      this.disposers.push(files.subscribe(this.bump));
      this.disposers.push(network.subscribe(this.bump));
      this.currentId = id;
      this.saveIndex();

      this.disposers.push(workspace.subscribe(this.bump));
      this.disposers.push(workspace.kernel.onResourcesChanged(this.bump));
      this.disposers.push(workspace.kernel.data.onChange(this.bump));
      this.disposers.push(
        workspace.onError(({ error, context }) => {
          // The same failure often repeats (e.g. every keystroke); show it once in a while.
          const key = `${context}:${error.message}`;
          const now = Date.now();
          if (now - (this.recentErrors.get(key) ?? 0) < 4000) return;
          this.recentErrors.set(key, now);
          this.toast({ tone: "error", title: context, message: error.message });
        }),
      );
      this.disposers.push(
        notifications.onNotify((notification) => {
          const tone: ToastTone = notification.level;
          this.toast({ tone, title: notification.title ?? notification.fromName, message: notification.message });
        }),
      );

      if (seed) {
        // Every new workspace starts with the two-application demonstration.
        const template = (id: string) => templates.find((candidate) => candidate.id === id) as (typeof templates)[number];
        const manager = await workspace.install(template("task-manager").build(workspace.registry));
        await workspace.install(template("task-dashboard").build(workspace.registry));
        this.selectedAppId = manager.id;
      } else {
        const remembered = readJson<string>(`clasp.lastApp.${id}`);
        this.selectedAppId = (remembered && workspace.app(remembered)?.id) || workspace.apps()[0]?.id;
      }
      this.section = "apps";
      this.mode = "use";
      this.status = "ready";
    } catch (error) {
      this.status = "error";
      this.error = toClaspError(error).message;
    }
    this.bump();
  }

  // ── navigation ──────────────────────────────────────────────────────────

  /** The selected application; falls back to the first one so an application is shown whenever any exist. */
  get app(): AppHandle | undefined {
    const selected = this.selectedAppId ? this.workspace?.app(this.selectedAppId) : undefined;
    return selected ?? this.workspace?.apps()[0];
  }

  selectApp(id: string): void {
    this.selectedAppId = id;
    this.selectedObjectId = undefined;
    this.section = "apps";
    writeJson(`clasp.lastApp.${this.currentId}`, id);
    this.raiseApp(id);
    this.bump();
  }

  // ── desktop windows ─────────────────────────────────────────────────────

  private topZ(): number {
    let top = 0;
    for (const state of Object.values(this.windows)) top = Math.max(top, state.z);
    return top;
  }

  /** Saves window placement shortly after the last change (moving a window is not worth a write per frame). */
  private persistWindows(): void {
    const workspace = this.workspace;
    if (!workspace) return;
    if (this.windowSave) clearTimeout(this.windowSave.timer);
    const save = (): Promise<void> =>
      workspace.storage.setMeta("desktop", { windows: this.windows }).catch((error: unknown) => this.reportError("Could not save the window layout", error));
    this.windowSave = {
      save,
      timer: setTimeout(() => {
        this.windowSave = undefined;
        void save();
      }, 250),
    };
  }

  private async flushWindows(): Promise<void> {
    const pending = this.windowSave;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.windowSave = undefined;
    await pending.save();
  }

  /** Gives newly seen windows their first position; they open in front. */
  placeWindows(entries: Record<string, Omit<WindowState, "z">>): void {
    let z = this.topZ();
    const next = { ...this.windows };
    for (const [key, state] of Object.entries(entries)) next[key] = { ...state, z: ++z };
    this.windows = next;
    this.persistWindows();
    this.bump();
  }

  updateWindow(key: string, patch: Partial<WindowState>): void {
    const state = this.windows[key];
    if (!state) return;
    this.windows = { ...this.windows, [key]: { ...state, ...patch } };
    this.persistWindows();
    this.bump();
  }

  /** Brings a window to the front (restoring it if hidden) and makes its application the selected one. */
  focusWindow(key: string, appId: string): void {
    const state = this.windows[key];
    if (!state) return;
    const top = this.topZ();
    const inFront = state.z === top && !state.minimized && !state.closed;
    const appChanged = this.selectedAppId !== appId || this.section !== "apps";
    if (inFront && this.focusedWindow === key && !appChanged) return;
    if (!inFront) this.windows = { ...this.windows, [key]: { ...state, z: top + 1, minimized: false, closed: false } };
    this.focusedWindow = key;
    if (appChanged) {
      this.selectedAppId = appId;
      this.selectedObjectId = undefined;
      this.section = "apps";
      writeJson(`clasp.lastApp.${this.currentId}`, appId);
    }
    this.persistWindows();
    this.bump();
  }

  minimizeWindow(key: string): void {
    this.updateWindow(key, { minimized: true });
    this.focusNextWindow(key);
  }

  /** Closes a window. The application keeps running; selecting it again reopens the window. */
  closeWindow(key: string): void {
    this.updateWindow(key, { closed: true, minimized: false, maximized: false });
    this.focusNextWindow(key);
  }

  /** After a window goes away, focus passes to the front-most remaining window, as on a desktop OS. */
  private focusNextWindow(hidden: string): void {
    if (this.focusedWindow !== undefined && this.focusedWindow !== hidden) return;
    const next = Object.entries(this.windows)
      .filter(([key, state]) => key !== hidden && !state.minimized && !state.closed && this.workspace?.app(key.split(":")[0] as string))
      .sort(([, a], [, b]) => b.z - a.z)[0];
    this.focusedWindow = next?.[0];
    const appId = next?.[0].split(":")[0];
    if (appId && appId !== this.selectedAppId) {
      this.selectedAppId = appId;
      this.selectedObjectId = undefined;
      writeJson(`clasp.lastApp.${this.currentId}`, appId);
    }
    this.bump();
  }

  toggleMaximize(key: string): void {
    const state = this.windows[key];
    if (state) this.updateWindow(key, { maximized: !state.maximized, z: this.topZ() + 1 });
  }

  /** Shows every window of an application in front of the others. */
  raiseApp(appId: string): void {
    const prefix = `${appId}:`;
    const keys = Object.keys(this.windows)
      .filter((key) => key.startsWith(prefix))
      .sort((a, b) => (this.windows[a] as WindowState).z - (this.windows[b] as WindowState).z);
    if (keys.length === 0) return;
    let z = this.topZ();
    const next = { ...this.windows };
    for (const key of keys) next[key] = { ...(next[key] as WindowState), z: ++z, minimized: false, closed: false };
    this.windows = next;
    this.focusedWindow = keys[keys.length - 1];
    this.persistWindows();
  }

  private forgetWindows(appId: string): void {
    const prefix = `${appId}:`;
    this.windows = Object.fromEntries(Object.entries(this.windows).filter(([key]) => !key.startsWith(prefix)));
    if (this.focusedWindow?.startsWith(prefix)) this.focusedWindow = undefined;
    this.persistWindows();
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.bump();
  }

  setSection(section: Section): void {
    this.section = section;
    this.bump();
  }

  selectObject(id: string | undefined): void {
    if (this.selectedObjectId === id) return;
    this.selectedObjectId = id;
    this.bump();
  }

  setAiOpen(open: boolean): void {
    this.aiOpen = open;
    if (open) this.featuresOpen = false;
    this.bump();
  }

  /** The Features panel: the selected application, edited feature by feature. */
  featuresOpen = false;

  setFeaturesOpen(open: boolean): void {
    this.featuresOpen = open;
    if (open) this.aiOpen = false;
    this.bump();
  }

  /**
   * Applies a feature change (from the Features panel) as one undoable
   * transaction, registering any kinds of record it defines first.
   */
  applyFeatureChange(appId: string, change: { operations: GraphOperation[]; schemas: SchemaDefinition[]; issues: string[] }, label: string): boolean {
    const workspace = this.workspace;
    const app = workspace?.app(appId);
    if (!workspace || !app) return false;
    if (change.issues.length > 0) {
      this.toast({ tone: "warning", message: change.issues[0] as string });
      return false;
    }
    if (change.operations.length === 0) return true;
    try {
      for (const schema of change.schemas) if (!workspace.schemas.has(schema.id, schema.version)) workspace.schemas.register(schema);
      app.store.transact(change.operations, { label, origin: "user" });
    } catch (error) {
      this.reportError("That change could not be made", error);
      return false;
    }
    this.bump();
    return true;
  }

  // ── applications ────────────────────────────────────────────────────────

  private uniqueName(base: string, except?: string): string {
    const taken = new Set((this.workspace?.apps() ?? []).filter((app) => app.id !== except).map((app) => app.store.graph.metadata.name));
    if (!taken.has(base)) return base;
    for (let index = 2; ; index++) {
      const candidate = `${base} ${index}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private async installGraph(graph: ClaspGraph, origin: string): Promise<AppHandle | undefined> {
    if (!this.workspace) return undefined;
    try {
      const app = await this.workspace.install(graph, { origin });
      this.selectApp(app.id);
      return app;
    } catch (error) {
      this.reportError("Could not add the application", error);
      return undefined;
    }
  }

  async createBlankApp(name = "Untitled app"): Promise<AppHandle | undefined> {
    const app = await this.installGraph(createGraph({ name: this.uniqueName(name) }), "user");
    if (app) this.setMode("build");
    return app;
  }

  async createFromTemplate(templateId: string): Promise<AppHandle | undefined> {
    const template = templates.find((candidate) => candidate.id === templateId);
    if (!template || !this.workspace) return undefined;
    try {
      const graph = template.build(this.workspace.registry);
      // Kinds of record the template defines (e.g. a board's cards).
      for (const schema of template.schemas?.(this.workspace.registry) ?? []) {
        if (!this.workspace.schemas.has(schema.id, schema.version)) this.workspace.schemas.register(schema);
      }
      const name = this.uniqueName(graph.metadata.name);
      return await this.installGraph({ ...graph, metadata: { ...graph.metadata, name } }, "template");
    } catch (error) {
      this.reportError("Could not create the application", error);
      return undefined;
    }
  }

  /**
   * Opens a file in the application that edits its kind (the Desktop
   * service's "open"): an existing one, or a new one from the matching
   * template. That application is given the file, as if picked in a dialog.
   */
  private async launchFile(file: FileEntry): Promise<string> {
    const workspace = this.workspace;
    const files = this.files;
    if (!workspace || !files) throw new Error("No workspace is open.");
    const documentOf = (app: AppHandle) =>
      Object.values(app.store.graph.objects).find((object) => object.type === "data.document" && (object.properties.kind ?? "text") === file.kind);
    let app = workspace.apps().find((candidate) => documentOf(candidate) !== undefined);
    if (!app) {
      const templateId = KIND_TEMPLATES[file.kind];
      if (!templateId) throw new Error(`No application here opens ${file.kind} files.`);
      app = await this.createFromTemplate(templateId);
      if (!app) throw new Error(`Could not start an application for ${file.kind} files.`);
    }
    const document = documentOf(app);
    if (!document) throw new Error(`${app.store.graph.metadata.name} cannot open this file.`);
    await files.allow(file.id, app.id, document.id);
    app.runtime.invoke(document.id, "openFile", { fileId: file.id });
    this.setMode("use");
    this.selectApp(app.id);
    return app.store.graph.metadata.name;
  }

  private environment() {
    const workspace = this.workspace as Workspace;
    return {
      registry: workspace.registry,
      schemas: workspace.schemas,
      exportedBy: "Clasp Studio 0.1.0",
      describeResource: (id: string) => {
        const resource = workspace.kernel.getResource(id);
        return resource ? { name: resource.name, kind: resource.kind, ...(resource.schema ? { schema: resource.schema.id } : {}) } : undefined;
      },
    };
  }

  /** Builds the portable package for an application. Contains no records and no grants. */
  async exportApp(appId: string): Promise<{ fileName: string; text: string } | undefined> {
    const app = this.workspace?.app(appId);
    if (!app || !this.workspace) return undefined;
    try {
      const presentation = await this.workspace.storage.loadPresentation(appId);
      const pkg = exportPackage(app.store.graph, { ...this.environment(), ...(presentation ? { presentation: { nodes: presentation.nodes } } : {}) });
      return { fileName: packageFileName(pkg), text: serializePackage(pkg) };
    } catch (error) {
      this.reportError("Could not export the application", error);
      return undefined;
    }
  }

  private async adopt(result: ImportResult, origin: string): Promise<AppHandle | undefined> {
    const name = this.uniqueName(result.graph.metadata.name);
    const app = await this.installGraph({ ...result.graph, metadata: { ...result.graph.metadata, name } }, origin);
    if (app && result.presentation && this.workspace) {
      await this.workspace.storage.savePresentation({ graphId: app.id, nodes: result.presentation.nodes });
    }
    return app;
  }

  /** Imports a package file. The new application gets a new identity and no permissions. */
  async importPackageText(text: string): Promise<AppHandle | undefined> {
    if (!this.workspace) return undefined;
    try {
      const result = importPackage(text, this.environment());
      const app = await this.adopt(result, "import");
      if (app) {
        const needs = result.requiredCapabilities.length;
        this.toast({
          tone: "success",
          title: `Imported “${app.store.graph.metadata.name}”`,
          message:
            needs > 0
              ? `It will ask for ${needs === 1 ? "one permission" : `${needs} permissions`}. Nothing was granted by importing it.`
              : "It needs no permissions.",
        });
      }
      return app;
    } catch (error) {
      this.reportError("Could not import the package", error);
      return undefined;
    }
  }

  async forkApp(appId: string): Promise<AppHandle | undefined> {
    const app = this.workspace?.app(appId);
    if (!app) return undefined;
    try {
      const forked = await this.adopt(forkGraph(app.store.graph, this.environment()), "fork");
      if (forked) this.toast({ tone: "success", message: `Forked as “${forked.store.graph.metadata.name}”. The fork has its own data and no permissions.` });
      return forked;
    } catch (error) {
      this.reportError("Could not fork the application", error);
      return undefined;
    }
  }

  async deleteApp(appId: string, deleteData: boolean): Promise<void> {
    if (!this.workspace) return;
    try {
      await this.workspace.uninstall(appId, { deleteData });
      this.forgetWindows(appId);
      if (this.selectedAppId === appId) {
        this.selectedAppId = this.workspace.apps()[0]?.id;
        this.selectedObjectId = undefined;
        this.mode = "use";
      }
      this.bump();
    } catch (error) {
      this.reportError("Could not delete the application", error);
    }
  }

  /** Applies graph operations to the selected application; failures become a toast, not an exception. */
  transact(operations: GraphOperation[], label: string): boolean {
    const app = this.app;
    if (!app) return false;
    try {
      app.store.transact(operations, { label, origin: "user" });
      return true;
    } catch (error) {
      this.reportError("That change is not valid", error);
      return false;
    }
  }

  // ── rendering host ──────────────────────────────────────────────────────

  readonly host: RenderHost = {
    resolveView: (hostAppId, targetAppId, viewName) => (this.workspace as Workspace).resolveView(hostAppId, targetAppId, viewName),
    appName: (appId) => this.workspace?.app(appId)?.store.graph.metadata.name,
  };

  // ── AI ──────────────────────────────────────────────────────────────────

  setAi(settings: Partial<AiSettings>): void {
    this.ai = { ...this.ai, ...settings };
    if (settings.model === undefined && "model" in settings) delete this.ai.model;
    writeJson(AI_KEY, this.ai);
    this.bump();
  }

  provider(): AIProvider {
    if (this.ai.provider === "scripted") return new ScriptedProvider();
    return new OllamaProvider({ baseUrl: this.ai.baseUrl, ...(this.ai.model ? { model: this.ai.model } : {}) });
  }

  assistant(): GraphAssistant {
    const workspace = this.workspace as Workspace;
    return new GraphAssistant({
      provider: this.provider(),
      registry: workspace.registry,
      schemas: workspace.schemas,
      extensions: [documentFeature],
      nameTaken: (name) => workspace.apps().some((app) => app.store.graph.metadata.name === name),
    });
  }

  /**
   * Applies or discards an AI proposal. A proposal for a new application
   * creates that application first; the one it was asked from is untouched.
   */
  async decideProposal(appId: string, entryId: number, apply: boolean): Promise<void> {
    const entry = this.aiThreads.proposal(appId, entryId);
    const workspace = this.workspace;
    if (!entry || entry.state !== "pending" || !workspace) return;
    if (!apply) {
      this.aiThreads.replace(appId, entryId, { state: "discarded" });
      return;
    }
    const { proposal } = entry;
    try {
      if (proposal.target.kind === "new") {
        const created = await workspace.install(createGraph({ name: this.uniqueName(proposal.target.name) }), { label: "Created by AI", origin: "ai" });
        try {
          applyProposal(created.store, proposal, workspace.schemas);
        } catch (error) {
          await workspace.uninstall(created.id, { deleteData: true }); // leave nothing half-made behind
          throw error;
        }
        this.aiThreads.replace(appId, entryId, { state: "applied", createdAppId: created.id });
        this.selectApp(created.id);
        this.toast({ tone: "success", message: `Created “${created.store.graph.metadata.name}”. It is open on the desktop.` });
      } else {
        const app = workspace.requireApp(appId);
        // A name the proposal gives the application must not clash with another application's.
        const operations = proposal.operations.map((operation) =>
          operation.op === "setMetadata" && operation.name ? { ...operation, name: this.uniqueName(operation.name, appId) } : operation,
        );
        applyProposal(app.store, { ...proposal, operations }, workspace.schemas);
        this.aiThreads.replace(appId, entryId, { state: "applied" });
        // Show the result: bring the changed application's windows forward.
        this.raiseApp(appId);
        this.bump();
      }
    } catch (error) {
      this.reportError("The proposal could not be applied", error);
    }
  }

  retargetProposal(appId: string, entryId: number, target: ProposalTarget): void {
    try {
      this.aiThreads.retarget(appId, entryId, target);
    } catch (error) {
      this.reportError("That change does not fit there", error);
    }
  }

  // ── tutorials ───────────────────────────────────────────────────────────

  get activeTutorial(): Tutorial | undefined {
    return this.tutorial && this.tutorial.workspaceId === this.currentId ? tutorialById(this.tutorial.id) : undefined;
  }

  /** The application this tutorial run is about: the first one created after it started. */
  get tutorialApp(): AppHandle | undefined {
    const run = this.tutorial;
    if (!run || run.workspaceId !== this.currentId) return undefined;
    return this.workspace?.apps().find((app) => !run.appsBefore.includes(app.id));
  }

  startTutorial(id: Tutorial["id"]): void {
    this.tutorial = { id, workspaceId: this.currentId, appsBefore: (this.workspace?.apps() ?? []).map((app) => app.id) };
    this.tutorialPickerOpen = false;
    this.section = "apps";
    writeJson(TUTORIAL_KEY, this.tutorial);
    this.bump();
  }

  endTutorial(): void {
    this.tutorial = undefined;
    this.highlight = undefined;
    try {
      localStorage.removeItem(TUTORIAL_KEY);
    } catch {
      // storage unavailable; nothing to clear
    }
    this.bump();
  }

  startRename(appId: string, where: "title" | "sidebar"): void {
    this.renaming = { appId, where };
    this.bump();
  }

  endRename(): void {
    this.renaming = undefined;
    this.bump();
  }

  /**
   * Renames an application as one undoable change. Windows titled with the
   * old name take the new one. Refuses an empty name or one another
   * application already has, and says why.
   */
  renameApp(appId: string, name: string): boolean {
    const app = this.workspace?.app(appId);
    if (!app) return false;
    const next = name.trim().replace(/\s+/g, " ");
    const previous = app.store.graph.metadata.name;
    if (next === previous) return true;
    if (!next) {
      this.toast({ tone: "warning", message: "An application needs a name." });
      return false;
    }
    if (next.length > 80) {
      this.toast({ tone: "warning", message: "That name is too long (80 characters at most)." });
      return false;
    }
    if ((this.workspace?.apps() ?? []).some((other) => other.id !== appId && other.store.graph.metadata.name === next)) {
      this.toast({ tone: "warning", message: `Another application is already called “${next}”.` });
      return false;
    }
    const windows = Object.values(app.store.graph.objects).filter((object) => object.type === "ui.window" && object.properties.title === previous);
    try {
      app.store.transact(
        [{ op: "setMetadata", name: next }, ...windows.map((window) => ({ op: "update" as const, objectId: window.id, properties: { title: next } }))],
        { label: `Rename to “${next}”`, origin: "user" },
      );
    } catch (error) {
      this.reportError("Could not rename the application", error);
      return false;
    }
    this.bump();
    return true;
  }

  setAppearanceOpen(open: boolean): void {
    this.appearanceOpen = open;
    this.bump();
  }

  /** Changes how the Studio looks and saves it with the workspace. */
  setAppearance(patch: Partial<Appearance>): void {
    this.appearance = normalizeAppearance({ ...this.appearance, ...patch });
    // Start-up uses this before a workspace is open (pictures stay in the workspace only).
    const { picture: _picture, ...light } = this.appearance;
    writeJson(APPEARANCE_KEY, light.background === "picture" ? { ...light, background: DEFAULT_APPEARANCE.background } : light);
    this.workspace?.storage.setMeta("appearance", this.appearance).catch((error: unknown) => this.reportError("Could not save the appearance", error));
    this.bump();
  }

  setTemplateGallery(open: boolean): void {
    this.templateGalleryOpen = open;
    this.bump();
  }

  setTutorialPicker(open: boolean): void {
    this.tutorialPickerOpen = open;
    this.bump();
  }

  /** Points at a control for a few seconds. */
  showMe(selector: string | undefined): void {
    this.highlight = selector;
    this.bump();
  }

  // ── files ───────────────────────────────────────────────────────────────

  /** Shows a file dialog on behalf of the file service and waits for the user. */
  private askFile(pending: { mode: "open"; request: FileDialogRequest }): Promise<string | undefined>;
  private askFile(pending: { mode: "save"; request: FileDialogRequest & { suggestedName: string } }): Promise<SaveChoice | undefined>;
  private askFile(
    pending: { mode: "open"; request: FileDialogRequest } | { mode: "save"; request: FileDialogRequest & { suggestedName: string } },
  ): Promise<string | SaveChoice | undefined> {
    this.answerFileDialog(undefined); // only one dialog at a time
    return new Promise<string | SaveChoice | undefined>((resolve) => {
      this.fileDialog =
        pending.mode === "open"
          ? { mode: "open", request: pending.request, resolve: (fileId) => resolve(fileId) }
          : { mode: "save", request: pending.request, resolve: (choice) => resolve(choice) };
      this.bump();
    });
  }

  /** The user's answer to the open file dialog (undefined cancels). */
  answerFileDialog(answer: string | SaveChoice | undefined): void {
    const pending = this.fileDialog;
    if (!pending) return;
    this.fileDialog = undefined;
    if (pending.mode === "open") pending.resolve(typeof answer === "string" ? answer : undefined);
    else pending.resolve(typeof answer === "object" ? answer : undefined);
    this.bump();
  }

  /** Brings a file from this computer into the workspace's files. */
  async importFromDisk(file: File): Promise<string | undefined> {
    if (!this.files) return undefined;
    try {
      const imported = importFile(file.name, await file.text());
      const entry = await this.files.create(imported.name, imported.kind, imported.content);
      this.toast({ tone: "success", message: `“${entry.name}” was added to your files.` });
      return entry.id;
    } catch (error) {
      this.reportError("Could not import the file", error);
      return undefined;
    }
  }

  /** Builds a copy of a workspace file to save on this computer. */
  exportToDisk(fileId: string): { fileName: string; text: string; mimeType: string } | undefined {
    const file = this.files?.get(fileId);
    return file ? exportFile(file) : undefined;
  }

  // ── toasts ──────────────────────────────────────────────────────────────

  toast(toast: Omit<Toast, "id">): void {
    this.toasts = [...this.toasts.slice(-4), { ...toast, id: createId("toast") }];
    this.bump();
  }

  dismissToast(id: string): void {
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
    this.bump();
  }

  reportError(title: string, error: unknown): void {
    const claspError = toClaspError(error);
    const details = isClaspError(error) ? claspError.issues.filter((entry) => entry.severity === "error") : [];
    const message = details.length > 1 ? `${claspError.message}` : claspError.message;
    this.toast({ tone: "error", title, message });
  }
}
