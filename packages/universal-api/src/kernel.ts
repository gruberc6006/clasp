import {
  ClaspError,
  Emitter,
  createId,
  deepClone,
  isJsonObject,
  nowIso,
  toClaspError,
  type JsonObject,
  type JsonValue,
} from "@clasp/core";
import { PermissionManager, type AccessDecision, type Capability } from "@clasp/permissions";
import type { SchemaRegistry } from "@clasp/schemas";
import { DataStore, type RecordPersistence } from "./data-store";
import { matchesFilter, sortRows } from "./filter";
import {
  CLASP_API_VERSION,
  SYSTEM_PRINCIPAL,
  flattenRecord,
  type AccessRequestInput,
  type CapabilityAlias,
  type ClaspAPI,
  type ClaspEvent,
  type ClaspRecord,
  type DiscoverQuery,
  type DiscoveredResource,
  type InvokeRequest,
  type MutateRequest,
  type MutateResult,
  type QueryRequest,
  type QueryResult,
  type RecordChange,
  type RecordOperation,
  type ResourceDescriptor,
  type ResourceInput,
  type ResourceKind,
  type SubscribeRequest,
  type Subscription,
} from "./types";

export interface Principal {
  id: string;
  name: string;
}

/**
 * How an application or service answers Universal API calls made on its
 * resource. Bound by the trusted host (the workspace), never by graph content.
 */
export interface ObjectProvider {
  /** Current values of the declared outputs. */
  values?(): JsonObject;
  /** Sets declared inputs. */
  setValues?(patch: JsonObject, caller: string): void | Promise<void>;
  /** Performs a declared action. */
  invoke?(action: string, args: JsonValue | undefined, caller: string): unknown;
}

export interface KernelErrorReport {
  error: ClaspError;
  context: string;
}

interface InternalSubscription {
  id: string;
  handle: string;
  principal: string;
  resource: string;
  event: string;
  handler: (event: ClaspEvent) => void;
  onError: ((error: ClaspError) => void) | undefined;
  active: boolean;
}

const SUPPORTED: Record<ResourceKind, Capability[]> = {
  collection: ["collection.query", "collection.mutate"],
  application: ["object.read", "object.write", "capability.invoke"],
  service: ["object.read", "object.write", "capability.invoke"],
};

const COLLECTION_EVENTS = new Set(["changed", "created", "updated", "deleted"]);

function resolveCapability(kind: ResourceKind, capability: Capability | CapabilityAlias): Capability {
  const aliases: Record<CapabilityAlias, Capability> =
    kind === "collection"
      ? { read: "collection.query", write: "collection.mutate", invoke: "capability.invoke" }
      : { read: "object.read", write: "object.write", invoke: "capability.invoke" };
  return (aliases as Record<string, Capability>)[capability] ?? (capability as Capability);
}

function invalid(message: string): ClaspError {
  return new ClaspError("VALIDATION_FAILED", message);
}

/**
 * The controlled boundary between applications.
 *
 * The kernel owns the resource registry, the data store and the permission
 * manager. Applications never touch those directly: each one is handed a
 * `ClaspAPI` bound to its identity (`connect`), and every call through that
 * handle is validated and authorized here.
 */
export class ClaspKernel {
  readonly schemas: SchemaRegistry;
  readonly permissions: PermissionManager;
  readonly data: DataStore;

  private readonly resources = new Map<string, ResourceDescriptor>();
  private readonly principals = new Map<string, Principal>([[SYSTEM_PRINCIPAL, { id: SYSTEM_PRINCIPAL, name: "Clasp" }]]);
  private readonly providers = new Map<string, ObjectProvider>();
  private readonly subscriptions = new Map<string, InternalSubscription>();
  private readonly resourceEvents = new Emitter<void>();
  private readonly errorEvents = new Emitter<KernelErrorReport>();

  constructor(options: { schemas: SchemaRegistry; permissions?: PermissionManager; persistence?: RecordPersistence }) {
    this.schemas = options.schemas;
    this.permissions = options.permissions ?? new PermissionManager();
    this.data = new DataStore(this.schemas, options.persistence);
    this.permissions.setOwnerResolver((resourceId) => this.resources.get(resourceId)?.ownerId);
    this.data.onChange(({ collectionId, changes }) => this.deliverRecordChanges(collectionId, changes));
    this.permissions.onChange((event) => {
      if (event.kind !== "granted" && event.kind !== "revoked") return;
      this.onAccessChanged(event.grant.subject, event.grant.resource);
    });
  }

  // ── host-side administration (trusted callers only) ─────────────────────

  registerPrincipal(principal: Principal): void {
    this.principals.set(principal.id, { ...principal });
    this.resourceEvents.emit();
  }

  principalName(id: string): string {
    return this.principals.get(id)?.name ?? id;
  }

  hasPrincipal(id: string): boolean {
    return this.principals.has(id);
  }

  /**
   * Declares exactly which resources `ownerId` provides, replacing its
   * previous declarations. Resources that disappear lose their grants and
   * their subscribers; records of removed collections stay in storage.
   */
  setResources(ownerId: string, inputs: readonly ResourceInput[]): void {
    const next = new Map<string, ResourceDescriptor>();
    for (const input of inputs) {
      try {
        const descriptor = this.normalize(ownerId, input);
        next.set(descriptor.id, descriptor);
      } catch (error) {
        this.report(toClaspError(error), `declaring resource "${input.name}" of ${this.principalName(ownerId)}`);
      }
    }
    for (const existing of [...this.resources.values()]) {
      if (existing.ownerId === ownerId && !next.has(existing.id)) this.removeResource(existing);
    }
    for (const descriptor of next.values()) {
      this.resources.set(descriptor.id, descriptor);
      if (descriptor.kind === "collection" && descriptor.schema) this.data.declareCollection(descriptor.id, descriptor.schema);
    }
    this.resourceEvents.emit();
  }

  /** Adds or replaces some of an owner's resources, keeping its others (used by independent system services). */
  addResources(ownerId: string, inputs: readonly ResourceInput[]): void {
    const replaced = new Set(inputs.map((input) => input.id));
    const kept = [...this.resources.values()].filter((resource) => resource.ownerId === ownerId && !replaced.has(resource.id));
    this.setResources(ownerId, [...kept, ...inputs]);
  }

  /** Removes a principal, everything it owns, and everything it was granted. */
  removePrincipal(principalId: string): void {
    this.setResources(principalId, []);
    this.permissions.cancelRequests(principalId);
    this.permissions.revokeWhere({ subject: principalId });
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.principal === principalId) this.close(subscription);
    }
    this.principals.delete(principalId);
    this.resourceEvents.emit();
  }

  getResource(id: string): ResourceDescriptor | undefined {
    const resource = this.resources.get(id);
    return resource ? deepClone(resource) : undefined;
  }

  /** Every registered resource. For the host's own UI (data explorer, permission manager). */
  listResources(): ResourceDescriptor[] {
    return [...this.resources.values()].map((resource) => deepClone(resource)).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Attaches the implementation that serves an application/service resource. */
  bindProvider(resourceId: string, provider: ObjectProvider): () => void {
    this.providers.set(resourceId, provider);
    return () => {
      if (this.providers.get(resourceId) === provider) this.providers.delete(resourceId);
    };
  }

  /** Announces an event (or an output change, as event `changed`) of an application/service resource. */
  publish(resourceId: string, event: string, payload?: JsonValue): void {
    for (const subscription of [...this.subscriptions.values()]) {
      if (!subscription.active || subscription.resource !== resourceId || subscription.event !== event) continue;
      if (!this.permissions.check({ subject: subscription.principal, capability: "object.read", resource: resourceId })) {
        this.terminate(subscription, this.denied(subscription.principal, "object.read", resourceId));
        continue;
      }
      this.dispatch(subscription, {
        source: resourceId,
        event,
        at: nowIso(),
        ...(payload !== undefined ? { payload: deepClone(payload) } : {}),
      });
    }
  }

  onResourcesChanged(listener: () => void): () => void {
    return this.resourceEvents.subscribe(listener);
  }

  /** Errors that have no caller to return to (subscriber exceptions, bad declarations). */
  onError(listener: (report: KernelErrorReport) => void): () => void {
    return this.errorEvents.subscribe(listener);
  }

  subscriptionCount(principalId?: string): number {
    return [...this.subscriptions.values()].filter(
      (subscription) => subscription.active && (principalId === undefined || subscription.principal === principalId),
    ).length;
  }

  // ── the Universal API ───────────────────────────────────────────────────

  /** Creates the API handle for one application. Its identity is fixed here. */
  connect(principalId: string): ClaspAPI {
    if (!this.principals.has(principalId)) {
      throw new ClaspError("NOT_FOUND", `Principal "${principalId}" is not registered with this workspace.`);
    }
    const handle = createId("handle");
    const guard = async <T>(run: () => Promise<T> | T): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        throw toClaspError(error);
      }
    };
    return {
      principal: principalId,
      version: CLASP_API_VERSION,
      discover: (query = {}) => guard(() => this.discover(principalId, query)),
      query: (request) => guard(() => this.query(principalId, request)),
      mutate: (request) => guard(() => this.mutate(principalId, request)),
      subscribe: (request) => this.subscribe(principalId, handle, request),
      invoke: (request) => guard(() => this.invoke(principalId, request)),
      requestAccess: (request) => guard(() => this.requestAccess(principalId, request)),
      dispose: () => {
        for (const subscription of [...this.subscriptions.values()]) {
          if (subscription.handle === handle) this.close(subscription);
        }
      },
    };
  }

  private discover(principal: string, query: DiscoverQuery): DiscoveredResource[] {
    if (!isJsonObject(query as unknown)) throw invalid("discover() expects a query object.");
    const schemaId = query.schema ?? query.type;
    const results: DiscoveredResource[] = [];
    for (const resource of this.resources.values()) {
      if (!this.isVisible(principal, resource)) continue;
      if (query.kind !== undefined && resource.kind !== query.kind) continue;
      if (query.ownerId !== undefined && resource.ownerId !== query.ownerId) continue;
      if (query.name !== undefined && resource.name !== query.name) continue;
      if (schemaId !== undefined) {
        if (!resource.schema || !this.schemas.has(schemaId)) continue;
        if (!this.schemas.checkCompatibility(resource.schema, { id: schemaId }).compatible) continue;
      }
      const owned = resource.ownerId === principal;
      const supported = SUPPORTED[resource.kind];
      const granted = this.permissions.granted(principal, resource.id);
      const access = owned ? [...supported] : supported.filter((capability) => granted.includes(capability));
      if (query.capability !== undefined) {
        const wanted = resolveCapability(resource.kind, query.capability);
        if (!supported.includes(wanted)) continue;
        if (query.access === "granted" && !access.includes(wanted)) continue;
      } else if (query.access === "granted" && access.length === 0) {
        continue;
      }
      results.push({
        ...deepClone(resource),
        ownerName: this.principalName(resource.ownerId),
        owned,
        capabilities: [...supported],
        access,
      });
    }
    return results.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  private query(principal: string, request: QueryRequest): QueryResult {
    if (!isJsonObject(request as unknown) || typeof request.source !== "string") throw invalid("query() needs a `source` resource id.");
    const resource = this.requireResource(request.source);
    if (resource.kind !== "collection") {
      this.permissions.authorize({ subject: principal, capability: "object.read", resource: resource.id });
      const values = this.providers.get(resource.id)?.values?.() ?? {};
      return { source: resource.id, records: [], total: 0, values: deepClone(values) };
    }
    this.permissions.authorize({ subject: principal, capability: "collection.query", resource: resource.id });
    const stored = resource.schema as { id: string; version: number };
    let view = stored;
    let records = this.data.list(resource.id);
    if (request.as !== undefined && request.as !== stored.id) {
      const target = this.schemas.require(request.as);
      view = { id: target.id, version: target.version };
      records = records.map((record) => ({
        ...record,
        schema: view,
        fields: this.schemas.mapFields(stored, view, record.fields),
      }));
    }
    const fields = this.schemas.require(view.id, view.version).fields;
    const known = (field: string): boolean => field === "id" || fields[field] !== undefined;
    for (const field of Object.keys(request.filter ?? {})) {
      if (!known(field)) throw invalid(`Cannot filter by "${field}": it is not a field of ${view.id}.`);
    }
    const sort = request.sort === undefined ? [] : Array.isArray(request.sort) ? request.sort : [request.sort];
    for (const spec of sort) {
      if (!known(spec.field)) throw invalid(`Cannot sort by "${spec.field}": it is not a field of ${view.id}.`);
    }
    if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 0)) throw invalid("`limit` must be a non-negative integer.");
    if (request.offset !== undefined && (!Number.isInteger(request.offset) || request.offset < 0)) throw invalid("`offset` must be a non-negative integer.");

    const rows = records.map((record) => ({ record, row: flattenRecord(record) })).filter(({ row }) => matchesFilter(row, request.filter));
    const order = new Map(sortRows(rows.map(({ row }) => row), sort).map((row, index) => [row.id as string, index]));
    rows.sort((a, b) => (order.get(a.record.id) ?? 0) - (order.get(b.record.id) ?? 0));
    const offset = request.offset ?? 0;
    const page = rows.slice(offset, request.limit === undefined ? undefined : offset + request.limit);
    return {
      source: resource.id,
      records: page.map(({ record }) => deepClone(record)),
      total: rows.length,
      schema: { ...view },
    };
  }

  private async mutate(principal: string, request: MutateRequest): Promise<MutateResult> {
    if (!isJsonObject(request as unknown) || typeof request.source !== "string") throw invalid("mutate() needs a `source` resource id.");
    const resource = this.requireResource(request.source);

    if (resource.kind !== "collection") {
      if (request.operation !== "set") throw invalid(`"${resource.name}" is not a collection; use operation "set" to change its inputs.`);
      this.permissions.authorize({ subject: principal, capability: "object.write", resource: resource.id });
      if (!isJsonObject(request.data)) throw invalid("`data` must be an object of input values.");
      for (const name of Object.keys(request.data)) {
        if (!resource.inputs.some((input) => input.name === name)) {
          throw invalid(`"${resource.name}" has no input named "${name}".`);
        }
      }
      const provider = this.providers.get(resource.id);
      if (!provider?.setValues) throw new ClaspError("UNAVAILABLE", `"${resource.name}" is not running.`);
      await provider.setValues(deepClone(request.data), principal);
      return { source: resource.id, changes: [], records: [] };
    }

    this.permissions.authorize({ subject: principal, capability: "collection.mutate", resource: resource.id });
    let operations: RecordOperation[];
    switch (request.operation) {
      case "create":
        operations = [{ operation: "create", data: request.data, ...(request.id !== undefined ? { id: request.id } : {}) }];
        break;
      case "update":
        operations = [
          {
            operation: "update",
            id: request.id,
            data: request.data,
            ...(request.expectedVersion !== undefined ? { expectedVersion: request.expectedVersion } : {}),
          },
        ];
        break;
      case "delete":
        operations = [
          { operation: "delete", id: request.id, ...(request.expectedVersion !== undefined ? { expectedVersion: request.expectedVersion } : {}) },
        ];
        break;
      case "batch":
        if (!Array.isArray(request.operations)) throw invalid("A batch needs an `operations` array.");
        operations = request.operations;
        break;
      default:
        throw invalid(`Unknown operation "${String((request as { operation?: unknown }).operation)}" for a collection.`);
    }
    for (const operation of operations) {
      if (operation.operation !== "create" && typeof operation.id !== "string") throw invalid(`A ${operation.operation} needs a record \`id\`.`);
      if (operation.operation !== "delete" && !isJsonObject(operation.data)) throw invalid(`A ${operation.operation} needs a \`data\` object.`);
    }
    const changes = await this.data.apply(resource.id, operations);
    return {
      source: resource.id,
      changes: deepClone(changes),
      records: changes.filter((change) => change.type !== "deleted").map((change) => deepClone(change.record)),
    };
  }

  private subscribe(principal: string, handle: string, request: SubscribeRequest): Subscription {
    if (!request || typeof request.source !== "string" || typeof request.handler !== "function") {
      throw invalid("subscribe() needs a `source` resource id and a `handler` function.");
    }
    const resource = this.requireResource(request.source);
    const event = request.event ?? "changed";
    if (event === "access") {
      if (!this.isVisible(principal, resource)) throw this.denied(principal, "discover", resource.id);
    } else if (resource.kind === "collection") {
      if (!COLLECTION_EVENTS.has(event)) throw new ClaspError("NOT_FOUND", `Collections have no "${event}" event.`);
      this.permissions.authorize({ subject: principal, capability: "collection.query", resource: resource.id });
    } else {
      if (event !== "changed" && !resource.events.some((entry) => entry.name === event)) {
        throw new ClaspError("NOT_FOUND", `"${resource.name}" has no event named "${event}".`);
      }
      this.permissions.authorize({ subject: principal, capability: "object.read", resource: resource.id });
    }
    const subscription: InternalSubscription = {
      id: createId("sub"),
      handle,
      principal,
      resource: resource.id,
      event,
      handler: request.handler,
      onError: request.onError,
      active: true,
    };
    this.subscriptions.set(subscription.id, subscription);
    const close = (): void => this.close(subscription);
    return {
      id: subscription.id,
      get active() {
        return subscription.active;
      },
      unsubscribe: close,
    };
  }

  private async invoke(principal: string, request: InvokeRequest): Promise<JsonValue | undefined> {
    if (!isJsonObject(request as unknown) || typeof request.target !== "string" || typeof request.action !== "string") {
      throw invalid("invoke() needs a `target` resource id and an `action` name.");
    }
    const resource = this.requireResource(request.target);
    if (resource.kind === "collection") {
      throw new ClaspError("INVALID_OPERATION", "Collections have no actions; use mutate() to change records.");
    }
    if (!resource.actions.some((action) => action.name === request.action)) {
      throw new ClaspError("NOT_FOUND", `"${resource.name}" has no action named "${request.action}".`);
    }
    // User-mediated actions ask the user inside the provider; everything else needs a grant.
    const mediated = resource.ownerId === SYSTEM_PRINCIPAL && (resource.mediatedActions ?? []).includes(request.action);
    if (!mediated) {
      this.permissions.authorize({
        subject: principal,
        capability: "capability.invoke",
        resource: resource.id,
        action: request.action,
      });
    }
    const provider = this.providers.get(resource.id);
    if (!provider?.invoke) throw new ClaspError("UNAVAILABLE", `"${resource.name}" is not running.`);
    const args = request.arguments === undefined ? undefined : deepClone(request.arguments);
    const result = await provider.invoke(request.action, args, principal);
    return result === undefined || result === null ? undefined : (deepClone(result) as JsonValue);
  }

  private requestAccess(principal: string, request: AccessRequestInput): Promise<AccessDecision> {
    if (!isJsonObject(request as unknown) || typeof request.resource !== "string" || !Array.isArray(request.capabilities)) {
      throw invalid("requestAccess() needs a `resource` id and a list of `capabilities`.");
    }
    const resource = this.requireResource(request.resource);
    if (!this.isVisible(principal, resource)) throw this.denied(principal, "request access", resource.id);
    if (request.capabilities.length === 0) throw invalid("Request at least one capability.");
    for (const capability of request.capabilities) {
      if (!SUPPORTED[resource.kind].includes(capability)) {
        throw invalid(`"${resource.name}" (${resource.kind}) does not support ${capability}.`);
      }
    }
    return this.permissions.request({
      subject: principal,
      resource: resource.id,
      capabilities: [...request.capabilities],
      ...(request.actions ? { actions: [...request.actions] } : {}),
      ...(request.reason ? { reason: request.reason } : {}),
    });
  }

  // ── internals ───────────────────────────────────────────────────────────

  private normalize(ownerId: string, input: ResourceInput): ResourceDescriptor {
    if (!input.id || !input.name) throw invalid("A resource needs an id and a name.");
    // `network:` ids name network hosts in grants; nobody may own one.
    if (input.id.startsWith("network:")) throw invalid(`Resource ids may not start with "network:" (${input.id}).`);
    const existing = this.resources.get(input.id);
    if (existing && existing.ownerId !== ownerId) {
      throw new ClaspError("CONFLICT", `Resource "${input.id}" already belongs to ${this.principalName(existing.ownerId)}.`);
    }
    let schema: { id: string; version: number } | undefined;
    if (input.kind === "collection") {
      if (!input.schema) throw invalid(`Collection "${input.name}" does not declare a schema.`);
      const resolved = this.schemas.get(input.schema.id, input.schema.version) ?? this.schemas.get(input.schema.id);
      if (!resolved) throw new ClaspError("NOT_FOUND", `Collection "${input.name}" uses unknown schema "${input.schema.id}".`);
      schema = { id: resolved.id, version: resolved.version };
    }
    return {
      id: input.id,
      kind: input.kind,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ownerId,
      exposure: input.exposure ?? "private",
      ...(schema ? { schema } : {}),
      actions: deepClone(input.actions ?? []),
      events: deepClone(input.events ?? []),
      outputs: deepClone(input.outputs ?? []),
      inputs: deepClone(input.inputs ?? []),
      views: deepClone(input.views ?? []),
      ...(input.mediatedActions ? { mediatedActions: [...input.mediatedActions] } : {}),
    };
  }

  private removeResource(resource: ResourceDescriptor): void {
    this.resources.delete(resource.id);
    this.providers.delete(resource.id);
    if (resource.kind === "collection") this.data.retireCollection(resource.id);
    const gone = new ClaspError("NOT_FOUND", `"${resource.name}" no longer exists.`);
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.resource === resource.id) this.terminate(subscription, gone);
    }
    this.permissions.revokeWhere({ resource: resource.id });
  }

  private requireResource(id: string): ResourceDescriptor {
    const resource = this.resources.get(id);
    if (!resource) throw new ClaspError("NOT_FOUND", `No resource with id "${id}" exists in this workspace.`);
    return resource;
  }

  /** A principal may know a resource exists if it owns it, it is discoverable, or it holds a grant on it. */
  private isVisible(principal: string, resource: ResourceDescriptor): boolean {
    return (
      resource.ownerId === principal ||
      resource.exposure === "discoverable" ||
      this.permissions.granted(principal, resource.id).length > 0
    );
  }

  private denied(principal: string, what: string, resource: string): ClaspError {
    return new ClaspError("PERMISSION_DENIED", `"${this.principalName(principal)}" is not allowed to ${what} on "${resource}".`, {
      details: { subject: principal, resource },
    });
  }

  private deliverRecordChanges(collectionId: string, changes: RecordChange[]): void {
    for (const subscription of [...this.subscriptions.values()]) {
      if (!subscription.active || subscription.resource !== collectionId || subscription.event === "access") continue;
      // Authorization is re-checked at every delivery, so revocation is immediate.
      if (!this.permissions.check({ subject: subscription.principal, capability: "collection.query", resource: collectionId })) {
        this.terminate(subscription, this.denied(subscription.principal, "collection.query", collectionId));
        continue;
      }
      const relevant = subscription.event === "changed" ? changes : changes.filter((change) => change.type === subscription.event);
      if (relevant.length === 0) continue;
      this.dispatch(subscription, { source: collectionId, event: subscription.event, at: nowIso(), changes: deepClone(relevant) });
    }
  }

  private onAccessChanged(subject: string, resourceId: string): void {
    const resource = this.resources.get(resourceId);
    for (const subscription of [...this.subscriptions.values()]) {
      if (!subscription.active || subscription.principal !== subject || subscription.resource !== resourceId) continue;
      if (subscription.event === "access") {
        const granted = this.permissions.granted(subject, resourceId);
        this.dispatch(subscription, { source: resourceId, event: "access", at: nowIso(), payload: { granted } });
        continue;
      }
      const capability: Capability = resource?.kind === "collection" ? "collection.query" : "object.read";
      if (!this.permissions.check({ subject, capability, resource: resourceId })) {
        this.terminate(subscription, this.denied(subject, capability, resourceId));
      }
    }
  }

  private dispatch(subscription: InternalSubscription, event: ClaspEvent): void {
    try {
      subscription.handler(event);
    } catch (error) {
      this.report(toClaspError(error), `event handler of ${this.principalName(subscription.principal)}`);
    }
  }

  private close(subscription: InternalSubscription): void {
    subscription.active = false;
    this.subscriptions.delete(subscription.id);
  }

  private terminate(subscription: InternalSubscription, error: ClaspError): void {
    if (!subscription.active) return;
    this.close(subscription);
    try {
      subscription.onError?.(error);
    } catch (handlerError) {
      this.report(toClaspError(handlerError), `error handler of ${this.principalName(subscription.principal)}`);
    }
  }

  private report(error: ClaspError, context: string): void {
    if (this.errorEvents.size === 0) {
      console.error(`[clasp] ${context}: ${error.message}`);
      return;
    }
    this.errorEvents.emit({ error, context });
  }
}

export type { ClaspRecord };
