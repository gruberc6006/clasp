import type { ClaspError, JsonObject, JsonValue } from "@clasp/core";
import type { AccessDecision, Capability } from "@clasp/permissions";

/** Version of the Universal API contract implemented by this kernel. */
export const CLASP_API_VERSION = 1;

/** The principal that owns built-in services. */
export const SYSTEM_PRINCIPAL = "clasp.system";

// ── data ──────────────────────────────────────────────────────────────────

/** One unit of persistent application data. */
export interface ClaspRecord {
  id: string;
  collectionId: string;
  /** Schema (and version) the record was last written under. */
  schema: { id: string; version: number };
  /** Revision of the record; incremented by every update. */
  version: number;
  createdAt: string;
  updatedAt: string;
  fields: JsonObject;
}

export interface RecordChange {
  type: "created" | "updated" | "deleted";
  collectionId: string;
  /** The record after the change (for deletions: the record that was removed). */
  record: ClaspRecord;
  /** The record before the change, for updates. */
  previous?: ClaspRecord;
}

/** Flattens a record to `{ id, ...fields }` — the shape components pass around. */
export function flattenRecord(record: ClaspRecord): JsonObject {
  return { ...record.fields, id: record.id };
}

// ── resources ─────────────────────────────────────────────────────────────

export type ResourceKind = "collection" | "application" | "service";

/** Whether other applications can find a resource through `discover`. */
export type Exposure = "private" | "discoverable";

export interface NamedMember {
  name: string;
  description?: string;
}

/**
 * Anything addressable through the Universal API: a collection of records, an
 * application's public interface, or a system service.
 */
export interface ResourceDescriptor {
  id: string;
  kind: ResourceKind;
  name: string;
  description?: string;
  /** Principal with authority over the resource. */
  ownerId: string;
  exposure: Exposure;
  /** Record schema, for collections. */
  schema?: { id: string; version: number };
  actions: NamedMember[];
  /**
   * Actions anyone may invoke without a grant because the provider itself
   * obtains the user's consent each time (e.g. a file dialog: the file the
   * user picks is the only one the caller gets). Only trusted system
   * services should declare these.
   */
  mediatedActions?: string[];
  events: NamedMember[];
  outputs: NamedMember[];
  inputs: NamedMember[];
  views: NamedMember[];
}

export type ResourceInput = Pick<ResourceDescriptor, "id" | "kind" | "name" | "ownerId"> &
  Partial<Omit<ResourceDescriptor, "id" | "kind" | "name" | "ownerId">>;

export interface DiscoveredResource extends ResourceDescriptor {
  ownerName: string;
  /** True when the caller owns the resource. */
  owned: boolean;
  /** Capabilities this kind of resource supports. */
  capabilities: Capability[];
  /** Capabilities the caller may use right now (ownership or grants). */
  access: Capability[];
}

// ── requests ──────────────────────────────────────────────────────────────

export type CapabilityAlias = "read" | "write" | "invoke";

export interface DiscoverQuery {
  kind?: ResourceKind;
  /** Schema id; matches collections whose records can be read as this schema. */
  schema?: string;
  /** Alias of `schema`. */
  type?: string;
  /** Only resources that support this capability. */
  capability?: Capability | CapabilityAlias;
  ownerId?: string;
  name?: string;
  /** `granted`: only resources the caller may already use (with `capability`, that capability). */
  access?: "any" | "granted";
}

export interface FilterOperators {
  $eq?: JsonValue;
  $ne?: JsonValue;
  $gt?: number | string;
  $gte?: number | string;
  $lt?: number | string;
  $lte?: number | string;
  $in?: JsonValue[];
  $contains?: string;
}

/** Field → required value, or field → operators. All conditions must hold. */
export type RecordFilter = Record<string, JsonValue | FilterOperators>;

export interface SortSpec {
  field: string;
  direction?: "asc" | "desc";
}

export interface QueryRequest {
  source: string;
  filter?: RecordFilter;
  sort?: SortSpec | SortSpec[];
  limit?: number;
  offset?: number;
  /** Read the records as this schema (uses version/extends compatibility or an explicit mapping). */
  as?: string;
}

export interface QueryResult {
  source: string;
  /** Matching records (empty for non-collection resources). */
  records: ClaspRecord[];
  /** Number of matches before `limit`/`offset`. */
  total: number;
  /** Schema the records are expressed in. */
  schema?: { id: string; version: number };
  /** Current output values, for application/service resources. */
  values?: JsonObject;
}

export type RecordOperation =
  | { operation: "create"; data: JsonObject; id?: string }
  | { operation: "update"; id: string; data: JsonObject; expectedVersion?: number }
  | { operation: "delete"; id: string; expectedVersion?: number };

export type MutateRequest =
  | ({ source: string } & RecordOperation)
  /** Several record operations applied atomically: all succeed or none do. */
  | { source: string; operation: "batch"; operations: RecordOperation[] }
  /** Sets declared inputs of an application/service resource. */
  | { source: string; operation: "set"; data: JsonObject };

export interface MutateResult {
  source: string;
  changes: RecordChange[];
  /** Records created or updated, in operation order. */
  records: ClaspRecord[];
}

export interface ClaspEvent {
  source: string;
  event: string;
  at: string;
  /** Record changes, for collection events. */
  changes?: RecordChange[];
  /** Event payload, for application/service events. */
  payload?: JsonValue;
}

export interface SubscribeRequest {
  source: string;
  /**
   * Collections: `changed` (default), `created`, `updated`, `deleted`.
   * Applications/services: `changed` (an output changed) or a declared event.
   * Any resource: `access` — the caller's own access to the resource changed.
   */
  event?: string;
  handler: (event: ClaspEvent) => void;
  /** Called once if the subscription is terminated (permission revoked, resource removed). */
  onError?: (error: ClaspError) => void;
}

export interface Subscription {
  readonly id: string;
  readonly active: boolean;
  unsubscribe(): void;
}

export interface InvokeRequest {
  target: string;
  action: string;
  arguments?: JsonValue;
}

export interface AccessRequestInput {
  resource: string;
  capabilities: Capability[];
  /** For `capability.invoke`: limit the request to these actions. */
  actions?: string[];
  reason?: string;
}

/**
 * The Universal API as seen by one application.
 *
 * A handle is bound to a principal by the host when it is created; callers
 * cannot choose or change who they are. Every method is authorized against
 * that principal and rejects with a `ClaspError`:
 *
 *  - VALIDATION_FAILED  malformed request or data that violates its schema
 *  - NOT_FOUND          unknown resource, record or action
 *  - PERMISSION_DENIED  the principal lacks the required capability
 *  - CONFLICT           optimistic concurrency check failed
 *  - INCOMPATIBLE       schemas cannot be reconciled
 *  - UNAVAILABLE        the resource exists but nothing is serving it
 *  - STORAGE_FAILURE    the change could not be persisted (and was not applied)
 */
export interface ClaspAPI {
  readonly principal: string;
  readonly version: number;
  /** Finds resources the caller is allowed to know about. */
  discover(query?: DiscoverQuery): Promise<DiscoveredResource[]>;
  /** Reads records (collections) or current values (applications/services). */
  query(request: QueryRequest): Promise<QueryResult>;
  /** Performs validated, transactional changes. */
  mutate(request: MutateRequest): Promise<MutateResult>;
  /** Reacts to changes. Throws synchronously if the caller is not allowed to listen. */
  subscribe(request: SubscribeRequest): Subscription;
  /** Runs an action exposed by another resource. */
  invoke(request: InvokeRequest): Promise<JsonValue | undefined>;
  /** Asks the user for access. Resolves once the user decides; grants nothing by itself. */
  requestAccess(request: AccessRequestInput): Promise<AccessDecision>;
  /** Ends every subscription made through this handle. */
  dispose(): void;
}
