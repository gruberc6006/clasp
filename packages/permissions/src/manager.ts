import { ClaspError, Emitter, createId, nowIso } from "@clasp/core";

/** The operations a principal can be allowed to perform on a resource. */
export type Capability =
  | "object.read"
  | "object.write"
  | "collection.query"
  | "collection.mutate"
  | "capability.invoke"
  | "network.request"
  | "storage.access";

export const CAPABILITIES: readonly Capability[] = [
  "object.read",
  "object.write",
  "collection.query",
  "collection.mutate",
  "capability.invoke",
  "network.request",
  "storage.access",
];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  "object.read": "Read values and events",
  "object.write": "Change inputs",
  "collection.query": "Read records",
  "collection.mutate": "Create, edit and delete records",
  "capability.invoke": "Run actions",
  "network.request": "Connect over the network",
  "storage.access": "Use private storage",
};

/**
 * One explicit permission: `subject` may perform `capability` on `resource`.
 * There are no wildcards — every grant names exactly one resource.
 */
export interface Grant {
  id: string;
  /** The principal (application id) receiving the permission. */
  subject: string;
  /** The resource id the permission applies to. */
  resource: string;
  capability: Capability;
  /** For `capability.invoke`: the only actions allowed. Absent means every action. */
  actions?: string[];
  grantedAt: string;
  /** Who created the grant: the user, or the id of an automated policy. */
  grantedBy: string;
}

export interface AccessRequest {
  id: string;
  subject: string;
  resource: string;
  capabilities: Capability[];
  actions?: string[];
  reason?: string;
  requestedAt: string;
}

export interface AccessDecision {
  granted: boolean;
  capabilities: Capability[];
}

export interface AccessCheck {
  subject: string;
  capability: Capability;
  resource: string;
  /** Action name, checked against the grant's action list for `capability.invoke`. */
  action?: string;
}

export type PermissionEvent =
  | { kind: "granted"; grant: Grant }
  | { kind: "revoked"; grant: Grant }
  | { kind: "requested"; request: AccessRequest }
  | { kind: "resolved"; request: AccessRequest; decision: AccessDecision };

/** Resolves who owns a resource. Supplied by whoever knows the resource registry. */
export type OwnerResolver = (resourceId: string) => string | undefined;

/**
 * Capability-based authorization.
 *
 * Rules, in full:
 *  1. The owner of a resource may do anything with it.
 *  2. Anyone else needs an explicit, resource-scoped grant.
 *  3. Nothing is granted implicitly — not by discovery, not by import,
 *     not by a request that the user has not approved.
 *
 * Checks are made here by the Universal API kernel at call time and again at
 * every event delivery, so revocation takes effect immediately.
 */
export class PermissionManager {
  private grants = new Map<string, Grant>();
  private readonly pending = new Map<string, { request: AccessRequest; resolve: (decision: AccessDecision) => void }>();
  private readonly events = new Emitter<PermissionEvent>();
  private ownerOf: OwnerResolver = () => undefined;

  setOwnerResolver(resolver: OwnerResolver): void {
    this.ownerOf = resolver;
  }

  /** True when `subject` owns the resource. */
  isOwner(subject: string, resource: string): boolean {
    return this.ownerOf(resource) === subject;
  }

  check(request: AccessCheck): boolean {
    if (this.isOwner(request.subject, request.resource)) return true;
    for (const grant of this.grants.values()) {
      if (grant.subject !== request.subject || grant.resource !== request.resource) continue;
      if (grant.capability !== request.capability) continue;
      if (grant.actions && request.action !== undefined && !grant.actions.includes(request.action)) continue;
      if (grant.actions && request.action === undefined && request.capability === "capability.invoke") continue;
      return true;
    }
    return false;
  }

  /** Throws PERMISSION_DENIED unless the check passes. */
  authorize(request: AccessCheck): void {
    if (this.check(request)) return;
    throw new ClaspError(
      "PERMISSION_DENIED",
      `"${request.subject}" is not allowed to ${request.capability}${request.action ? ` (${request.action})` : ""} on "${request.resource}".`,
      { details: { ...request } },
    );
  }

  /** Capabilities `subject` holds on `resource` through grants (ownership not included). */
  granted(subject: string, resource: string): Capability[] {
    const found = new Set<Capability>();
    for (const grant of this.grants.values()) {
      if (grant.subject === subject && grant.resource === resource) found.add(grant.capability);
    }
    return [...found];
  }

  grant(input: { subject: string; resource: string; capability: Capability; actions?: string[]; grantedBy?: string }): Grant {
    if (!CAPABILITIES.includes(input.capability)) {
      throw new ClaspError("VALIDATION_FAILED", `Unknown capability "${String(input.capability)}".`);
    }
    if (!input.subject || !input.resource) {
      throw new ClaspError("VALIDATION_FAILED", "A grant needs a subject and a resource.");
    }
    if (input.resource === "*" || input.subject === "*") {
      throw new ClaspError("VALIDATION_FAILED", "Wildcard grants are not supported; grants are scoped to one resource.");
    }
    for (const existing of this.grants.values()) {
      if (
        existing.subject === input.subject &&
        existing.resource === input.resource &&
        existing.capability === input.capability &&
        JSON.stringify(existing.actions ?? null) === JSON.stringify(input.actions ?? null)
      ) {
        return existing;
      }
    }
    const grant: Grant = {
      id: createId("grant"),
      subject: input.subject,
      resource: input.resource,
      capability: input.capability,
      ...(input.actions ? { actions: [...input.actions] } : {}),
      grantedAt: nowIso(),
      grantedBy: input.grantedBy ?? "user",
    };
    this.grants.set(grant.id, grant);
    this.events.emit({ kind: "granted", grant });
    return grant;
  }

  /** Revokes one grant. Returns false when it did not exist. */
  revoke(grantId: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant) return false;
    this.grants.delete(grantId);
    this.events.emit({ kind: "revoked", grant });
    return true;
  }

  /** Revokes every grant matching the filter and returns how many were removed. */
  revokeWhere(filter: { subject?: string; resource?: string; capability?: Capability }): number {
    let count = 0;
    for (const grant of [...this.grants.values()]) {
      if (filter.subject !== undefined && grant.subject !== filter.subject) continue;
      if (filter.resource !== undefined && grant.resource !== filter.resource) continue;
      if (filter.capability !== undefined && grant.capability !== filter.capability) continue;
      if (this.revoke(grant.id)) count++;
    }
    return count;
  }

  list(filter: { subject?: string; resource?: string } = {}): Grant[] {
    return [...this.grants.values()]
      .filter(
        (grant) =>
          (filter.subject === undefined || grant.subject === filter.subject) &&
          (filter.resource === undefined || grant.resource === filter.resource),
      )
      .sort((a, b) => (a.grantedAt < b.grantedAt ? -1 : a.grantedAt > b.grantedAt ? 1 : 0));
  }

  /**
   * Records a request for access and waits for the user's decision.
   * Nothing is granted until `resolveRequest` is called with `approve: true`.
   */
  request(input: Omit<AccessRequest, "id" | "requestedAt">): Promise<AccessDecision> {
    const holds = (capability: Capability): boolean => {
      const base = { subject: input.subject, capability, resource: input.resource };
      if (capability === "capability.invoke" && input.actions && input.actions.length > 0) {
        return input.actions.every((action) => this.check({ ...base, action }));
      }
      return this.check(base);
    };
    const missing = input.capabilities.filter((capability) => !holds(capability));
    if (missing.length === 0) return Promise.resolve({ granted: true, capabilities: [...input.capabilities] });
    const request: AccessRequest = { ...input, capabilities: missing, id: createId("req"), requestedAt: nowIso() };
    return new Promise<AccessDecision>((resolve) => {
      this.pending.set(request.id, { request, resolve });
      this.events.emit({ kind: "requested", request });
    });
  }

  pendingRequests(): AccessRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  /** The user's answer to an access request. */
  resolveRequest(requestId: string, approve: boolean): AccessDecision {
    const entry = this.pending.get(requestId);
    if (!entry) throw new ClaspError("NOT_FOUND", `Access request "${requestId}" is not pending.`);
    this.pending.delete(requestId);
    const { request } = entry;
    if (approve) {
      for (const capability of request.capabilities) {
        this.grant({
          subject: request.subject,
          resource: request.resource,
          capability,
          ...(request.actions && capability === "capability.invoke" ? { actions: request.actions } : {}),
        });
      }
    }
    const decision: AccessDecision = { granted: approve, capabilities: approve ? [...request.capabilities] : [] };
    this.events.emit({ kind: "resolved", request, decision });
    entry.resolve(decision);
    return decision;
  }

  /** Denies every pending request from one subject (e.g. when its app is removed). */
  cancelRequests(subject: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.request.subject === subject) this.resolveRequest(entry.request.id, false);
    }
  }

  onChange(listener: (event: PermissionEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  /** Grants as plain data, for persistence. */
  snapshot(): Grant[] {
    return this.list().map((grant) => ({ ...grant, ...(grant.actions ? { actions: [...grant.actions] } : {}) }));
  }

  /** Replaces all grants with previously persisted ones. Emits no events. */
  load(grants: readonly Grant[]): void {
    this.grants = new Map(grants.map((grant) => [grant.id, { ...grant }]));
  }
}
