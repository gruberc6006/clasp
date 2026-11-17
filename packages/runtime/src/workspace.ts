import {
  ClaspError,
  Emitter,
  GraphStore,
  hasErrors,
  toClaspError,
  validateGraph,
  validationError,
  type ClaspGraph,
  type GraphEvent,
} from "@clasp/core";
import type { Grant } from "@clasp/permissions";
import type { WorkspaceStorage } from "@clasp/persistence";
import { createSchemaRegistry, BUILTIN_SCHEMA_IDS, type SchemaDefinition, type SchemaRegistry } from "@clasp/schemas";
import { ClaspKernel, type ClaspAPI, type ResourceInput } from "@clasp/universal-api";
import type { CapabilityRequirement } from "./component";
import type { ComponentRegistry } from "./registry";
import { GraphRuntime, type RuntimeLimits, type TimerHost } from "./runtime";

/** One installed, running application. */
export interface AppHandle {
  readonly id: string;
  readonly store: GraphStore;
  readonly runtime: GraphRuntime;
  /** The app's own Universal API handle (its identity is fixed to the app). */
  readonly clasp: ClaspAPI;
}

export interface RequirementStatus extends CapabilityRequirement {
  /** Whether the app may currently use the capability. */
  satisfied: boolean;
  /** Whether the target resource exists in this workspace. */
  resolved: boolean;
}

export interface WorkspaceErrorReport {
  error: ClaspError;
  context: string;
  appId?: string;
}

export interface WorkspaceOptions {
  storage: WorkspaceStorage;
  registry: ComponentRegistry;
  schemas?: SchemaRegistry;
  /**
   * Called once the kernel and data are ready but before any application
   * starts — the place for hosts to register system services (files,
   * notifications…) that applications may call as soon as they start.
   */
  setup?: (workspace: Workspace) => void;
  limits?: Partial<RuntimeLimits>;
  timers?: TimerHost;
}

/** Collects the resources an application graph declares: itself, plus whatever its objects declare. */
export function declaredResources(graph: ClaspGraph, registry: ComponentRegistry): ResourceInput[] {
  const face = graph.interface;
  const exposesAnything = Object.values(face).some((entries) => entries.length > 0);
  const strip = (entries: Array<{ name: string; description?: string }>) =>
    entries.map((entry) => ({ name: entry.name, ...(entry.description ? { description: entry.description } : {}) }));
  const resources: ResourceInput[] = [
    {
      id: graph.id,
      kind: "application",
      name: graph.metadata.name,
      ...(graph.metadata.description ? { description: graph.metadata.description } : {}),
      ownerId: graph.id,
      exposure: exposesAnything ? "discoverable" : "private",
      actions: strip(face.actions),
      events: strip(face.events),
      outputs: strip(face.outputs),
      inputs: strip(face.inputs),
      views: strip(face.views),
    },
  ];
  for (const object of Object.values(graph.objects)) {
    for (const declaration of registry.get(object.type)?.resources?.(object) ?? []) {
      resources.push({
        id: declaration.id,
        kind: declaration.kind,
        name: declaration.name,
        ...(declaration.description ? { description: declaration.description } : {}),
        ownerId: graph.id,
        exposure: declaration.exposure,
        schema: { id: declaration.schema.id, version: declaration.schema.version ?? 0 },
      });
    }
  }
  return resources;
}

/**
 * A persistent computational environment: the applications installed in it,
 * the kernel that mediates between them, and the storage behind both.
 *
 * Every installed application runs continuously (with or without a visible
 * interface), so applications can serve each other and keep their state when
 * the user switches views.
 */
export class Workspace {
  readonly kernel: ClaspKernel;
  readonly registry: ComponentRegistry;
  readonly storage: WorkspaceStorage;
  readonly schemas: SchemaRegistry;

  private readonly installed = new Map<string, AppHandle>();
  private readonly teardown = new Map<string, Array<() => void>>();
  private readonly listeners = new Emitter<void>();
  private readonly errors = new Emitter<WorkspaceErrorReport>();
  private readonly options: WorkspaceOptions;
  private saving: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(options: WorkspaceOptions, schemas: SchemaRegistry) {
    this.options = options;
    this.registry = options.registry;
    this.storage = options.storage;
    this.schemas = schemas;
    this.kernel = new ClaspKernel({ schemas, persistence: options.storage });
    this.registry.setEnvironment({ resolveResource: (id) => this.kernel.getResource(id) });
    this.kernel.onError(({ error, context }) => this.errors.emit({ error, context }));
  }

  /** Opens a workspace: loads schemas, records, grants and applications, then starts every application. */
  static async open(options: WorkspaceOptions): Promise<Workspace> {
    const schemas = options.schemas ?? createSchemaRegistry();
    for (const definition of await options.storage.loadSchemas<SchemaDefinition>()) {
      if (!schemas.has(definition.id, definition.version)) schemas.register(definition);
    }
    const workspace = new Workspace(options, schemas);
    await workspace.kernel.data.hydrate();
    workspace.kernel.permissions.load(await options.storage.loadGrants<Grant>());
    workspace.kernel.permissions.onChange((event) => {
      if (event.kind === "granted" || event.kind === "revoked") {
        workspace.enqueueSave("saving permissions", () => workspace.storage.saveGrants(workspace.kernel.permissions.snapshot()));
      }
      workspace.listeners.emit();
    });
    schemas.onChange(({ kind, id }) => {
      if (kind !== "schema" || BUILTIN_SCHEMA_IDS.includes(id)) return;
      for (const definition of schemas.definitionsOf(id)) {
        workspace.enqueueSave("saving a schema", () => workspace.storage.saveSchema(definition));
      }
    });

    options.setup?.(workspace);

    const graphs = await options.storage.loadGraphs();
    graphs.sort((a, b) => (a.metadata.createdAt < b.metadata.createdAt ? -1 : a.metadata.createdAt > b.metadata.createdAt ? 1 : 0));
    // Register every application's resources before starting any of them, so
    // cross-application references resolve regardless of start order.
    const mounted = graphs.map((graph) => workspace.mount(graph));
    for (const app of mounted) app.runtime.start();
    return workspace;
  }

  // ── applications ────────────────────────────────────────────────────────

  apps(): AppHandle[] {
    return [...this.installed.values()];
  }

  app(id: string): AppHandle | undefined {
    return this.installed.get(id);
  }

  requireApp(id: string): AppHandle {
    const app = this.installed.get(id);
    if (!app) throw new ClaspError("NOT_FOUND", `No application "${id}" is installed in this workspace.`);
    return app;
  }

  /**
   * Installs an application definition and starts it. The graph is validated
   * against the component registry first; nothing is stored if it is invalid.
   * A new application never starts with any grants.
   */
  async install(graph: ClaspGraph, meta: { label?: string; origin?: string } = {}): Promise<AppHandle> {
    this.assertOpen();
    if (this.installed.has(graph.id)) throw new ClaspError("ALREADY_EXISTS", `Application "${graph.id}" is already installed.`);
    const issues = validateGraph(graph, this.registry);
    if (hasErrors(issues)) throw validationError(`"${graph.metadata.name}" cannot be installed`, issues);
    try {
      await this.storage.saveGraph(graph, { label: meta.label ?? "Installed", origin: meta.origin ?? "system" });
    } catch (cause) {
      throw toClaspError(cause, "STORAGE_FAILURE");
    }
    const app = this.mount(graph);
    app.runtime.start();
    this.listeners.emit();
    return app;
  }

  /**
   * Removes an application: its runtime, its resources, every grant given to
   * it or on its resources, and its stored definition. Its records are kept
   * unless `deleteData` is set.
   */
  async uninstall(appId: string, options: { deleteData?: boolean } = {}): Promise<void> {
    const app = this.requireApp(appId);
    const collections = declaredResources(app.store.graph, this.registry)
      .filter((resource) => resource.kind === "collection")
      .map((resource) => resource.id);
    for (const dispose of this.teardown.get(appId) ?? []) dispose();
    this.teardown.delete(appId);
    app.runtime.stop();
    app.clasp.dispose();
    this.kernel.removePrincipal(appId);
    this.installed.delete(appId);
    if (options.deleteData) {
      for (const collectionId of collections) await this.kernel.data.purge(collectionId);
    }
    await this.settleSaves();
    await this.storage.deleteGraph(appId);
    this.listeners.emit();
  }

  /** Capabilities the app's objects need on other resources, and whether each is currently granted. */
  requirements(appId: string): RequirementStatus[] {
    const app = this.requireApp(appId);
    const result: RequirementStatus[] = [];
    for (const object of Object.values(app.store.graph.objects)) {
      for (const requirement of this.registry.get(object.type)?.requirements?.(object) ?? []) {
        const resolved = this.kernel.getResource(requirement.resource) !== undefined;
        const check = (action?: string): boolean =>
          this.kernel.permissions.check({
            subject: appId,
            capability: requirement.capability,
            resource: requirement.resource,
            ...(action !== undefined ? { action } : {}),
          });
        const satisfied = resolved && (requirement.actions?.length ? requirement.actions.every((action) => check(action)) : check());
        result.push({ ...requirement, objectId: object.id, satisfied, resolved });
      }
    }
    return result;
  }

  /**
   * Resolves a view another application exposes, for embedding. The host
   * application must hold `object.read` on the target; only declared views
   * are reachable.
   */
  resolveView(hostAppId: string, targetAppId: string, viewName?: string): { app: AppHandle; rootId: string; name: string } {
    const target = this.installed.get(targetAppId);
    if (!target) throw new ClaspError("NOT_FOUND", `Application "${targetAppId}" is not installed in this workspace.`);
    this.kernel.permissions.authorize({ subject: hostAppId, capability: "object.read", resource: targetAppId });
    const views = target.store.graph.interface.views;
    const view = viewName ? views.find((entry) => entry.name === viewName) : views[0];
    if (!view) {
      throw new ClaspError(
        "NOT_FOUND",
        viewName ? `"${target.store.graph.metadata.name}" exposes no view named "${viewName}".` : `"${target.store.graph.metadata.name}" exposes no views.`,
      );
    }
    return { app: target, rootId: view.root, name: view.name };
  }

  // ── lifecycle & observation ─────────────────────────────────────────────

  /** Fires when applications are added or removed, renamed, or permissions change. */
  subscribe(listener: () => void): () => void {
    return this.listeners.subscribe(listener);
  }

  onError(listener: (report: WorkspaceErrorReport) => void): () => void {
    return this.errors.subscribe(listener);
  }

  /** Resolves when every application is idle and everything is saved. */
  async settle(): Promise<void> {
    for (let round = 0; round < 200; round++) {
      await Promise.all(this.apps().map((app) => app.runtime.whenIdle()));
      await this.settleSaves();
      // One macrotask turn lets cross-application reactions (event → query → output) surface.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.apps().every((app) => !app.runtime.busy)) return;
    }
    throw new ClaspError("EXECUTION_LIMIT_EXCEEDED", "The workspace never became idle.");
  }

  /** Stops every application and releases storage. Nothing is deleted. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.settleSaves();
    this.closed = true;
    for (const [appId, disposers] of this.teardown) {
      for (const dispose of disposers) dispose();
      this.installed.get(appId)?.runtime.stop();
      this.installed.get(appId)?.clasp.dispose();
    }
    this.teardown.clear();
    this.installed.clear();
    this.storage.adapter.close();
  }

  // ── internals ───────────────────────────────────────────────────────────

  private mount(graph: ClaspGraph): AppHandle {
    const store = new GraphStore(graph, { catalog: this.registry });
    this.kernel.registerPrincipal({ id: graph.id, name: graph.metadata.name });
    this.kernel.setResources(graph.id, declaredResources(graph, this.registry));
    const clasp = this.kernel.connect(graph.id);
    const runtime = new GraphRuntime({
      store,
      registry: this.registry,
      clasp,
      ...(this.options.limits ? { limits: this.options.limits } : {}),
      ...(this.options.timers ? { timers: this.options.timers } : {}),
    });
    const app: AppHandle = { id: graph.id, store, runtime, clasp };
    this.installed.set(graph.id, app);

    const disposers: Array<() => void> = [];
    disposers.push(
      store.subscribe((event: GraphEvent) => {
        // The definition changed: re-declare resources, then persist. Records are untouched.
        this.kernel.registerPrincipal({ id: graph.id, name: event.graph.metadata.name });
        this.kernel.setResources(graph.id, declaredResources(event.graph, this.registry));
        const snapshot = event.graph;
        this.enqueueSave(
          "saving an application",
          () => this.storage.saveGraph(snapshot, { ...(event.label ? { label: event.label } : {}), origin: event.origin }),
          graph.id,
        );
        this.listeners.emit();
      }),
    );
    // The application answers Universal API calls on its own resource through
    // its declared interface — and nothing else.
    disposers.push(
      this.kernel.bindProvider(graph.id, {
        values: () => runtime.interfaceValues(),
        setValues: (patch) => runtime.setInterfaceInputs(patch),
        invoke: (action, args) => runtime.invokeInterfaceAction(action, args),
      }),
    );
    disposers.push(
      runtime.onEvent(({ objectId, event, payload }) => {
        for (const entry of store.graph.interface.events) {
          if (entry.source.objectId === objectId && entry.source.port === event) this.kernel.publish(graph.id, entry.name, payload);
        }
      }),
    );
    disposers.push(
      runtime.onOutput(({ objectId, port, value }) => {
        for (const entry of store.graph.interface.outputs) {
          if (entry.source.objectId === objectId && entry.source.port === port) {
            this.kernel.publish(graph.id, "changed", { name: entry.name, value: value ?? null });
          }
        }
      }),
    );
    disposers.push(
      runtime.onDiagnostic((diagnostic) => {
        if (diagnostic.severity === "error") {
          this.errors.emit({
            error: new ClaspError("INTERNAL", diagnostic.message, { details: { code: diagnostic.code, objectId: diagnostic.objectId } }),
            context: store.graph.metadata.name,
            appId: graph.id,
          });
        }
      }),
    );
    this.teardown.set(graph.id, disposers);
    return app;
  }

  private enqueueSave(context: string, save: () => Promise<void>, appId?: string): void {
    this.saving = this.saving
      .then(() => (this.closed ? undefined : save()))
      .catch((cause) => {
        this.errors.emit({ error: toClaspError(cause, "STORAGE_FAILURE"), context, ...(appId ? { appId } : {}) });
      });
  }

  private async settleSaves(): Promise<void> {
    let current: Promise<unknown> | undefined;
    while (current !== this.saving) {
      current = this.saving;
      await current;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new ClaspError("UNAVAILABLE", "This workspace has been closed.");
  }
}
