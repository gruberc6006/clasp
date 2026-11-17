import { ClaspError, isJsonObject, type JsonObject, type JsonValue } from "@clasp/core";
import type { Capability } from "@clasp/permissions";
import type { ComponentContext, ComponentDefinition, ComponentInstance } from "@clasp/runtime";
import { flattenRecord, matchesFilter, sortRows, type RecordFilter, type SortSpec, type Subscription } from "@clasp/universal-api";
import { OPERATORS, asNumber, asRows, asText, isUnary, pure, test } from "./helpers";

/** Port lists shared by the two components that front a collection. */
const recordOutputs: ComponentDefinition["outputs"] = [
  { name: "records", type: "records", description: "Every record, as { id, ...fields } rows. Updates live." },
  { name: "count", type: "number" },
  { name: "error", type: "string", description: "Message of the last failed operation, if any." },
];
const recordEvents: ComponentDefinition["events"] = [
  { name: "changed", description: "Records were created, updated or deleted." },
  { name: "failed", payload: "object", description: "An operation was rejected. Payload: { code, message }." },
];
const recordActions: ComponentDefinition["actions"] = [
  { name: "create", payload: "object", description: "Creates a record from an object of field values." },
  { name: "update", payload: "object", description: "Updates a record. Payload: { id, changes } (or { id, ...fields })." },
  { name: "delete", payload: "object", description: "Deletes a record. Payload: { id }." },
  { name: "refresh", description: "Reloads the records." },
];

function changesOf(payload: JsonObject): JsonObject {
  if (isJsonObject(payload.changes)) return payload.changes;
  const { id: _id, ...rest } = payload;
  return rest;
}

/**
 * Shared behavior for reading and writing one collection through the
 * Universal API: load, stay subscribed, and turn actions into mutations.
 * Every call is authorized by the kernel against this application's identity.
 */
function collectionAccess(
  ctx: ComponentContext,
  collectionId: () => string | undefined,
  hooks: { onDenied?: (error: ClaspError) => void; onLoaded?: () => void } = {},
) {
  let subscription: Subscription | undefined;

  const failed = (error: ClaspError): void => {
    ctx.setOutput("error", error.message);
    ctx.emit("failed", { code: error.code, message: error.message });
    ctx.fail(error);
  };

  const load = (): void => {
    const source = collectionId();
    if (!source) return;
    ctx.run(
      async () => {
        const result = await ctx.clasp.query({ source });
        if (!ctx.alive) return;
        ctx.setOutput("records", result.records.map(flattenRecord));
        ctx.setOutput("count", result.total);
        ctx.setOutput("error", undefined);
        hooks.onLoaded?.();
      },
      (error) => {
        ctx.setOutput("records", []);
        ctx.setOutput("count", 0);
        if (hooks.onDenied && (error.code === "PERMISSION_DENIED" || error.code === "NOT_FOUND")) hooks.onDenied(error);
        else failed(error);
      },
    );
  };

  const watch = (): void => {
    const source = collectionId();
    if (!source || subscription?.active) return;
    try {
      subscription = ctx.clasp.subscribe({
        source,
        event: "changed",
        handler: () => {
          if (!ctx.alive) return;
          load();
          ctx.emit("changed");
        },
        onError: (error) => {
          // Access was revoked or the collection went away: drop the data immediately.
          subscription = undefined;
          if (!ctx.alive) return;
          ctx.setOutput("records", []);
          ctx.setOutput("count", 0);
          if (hooks.onDenied) hooks.onDenied(error);
          else failed(error);
        },
      });
    } catch (error) {
      subscription = undefined;
      // The initial query reports the same problem; nothing more to do here.
      void error;
    }
  };

  const mutate = (request: (source: string) => Parameters<ComponentContext["clasp"]["mutate"]>[0]): void => {
    const source = collectionId();
    if (!source) {
      failed(new ClaspError("INVALID_OPERATION", "No collection is connected."));
      return;
    }
    ctx.run(async () => {
      await ctx.clasp.mutate(request(source));
      if (ctx.alive) ctx.setOutput("error", undefined);
    }, failed);
  };

  const actions: NonNullable<ComponentInstance["actions"]> = {
    create: (payload) => {
      if (!isJsonObject(payload)) return failed(new ClaspError("VALIDATION_FAILED", "create expects an object of field values."));
      const { id: _ignored, ...data } = payload;
      mutate((source) => ({ source, operation: "create", data }));
    },
    update: (payload) => {
      if (!isJsonObject(payload) || typeof payload.id !== "string") {
        return failed(new ClaspError("VALIDATION_FAILED", "update expects { id, changes }."));
      }
      const id = payload.id;
      const data = changesOf(payload);
      mutate((source) => ({ source, operation: "update", id, data }));
    },
    delete: (payload) => {
      const id = isJsonObject(payload) ? payload.id : payload;
      if (typeof id !== "string") return failed(new ClaspError("VALIDATION_FAILED", "delete expects { id }."));
      mutate((source) => ({ source, operation: "delete", id }));
    },
    refresh: () => load(),
  };

  return {
    load,
    watch,
    actions,
    stop: () => {
      subscription?.unsubscribe();
      subscription = undefined;
    },
  };
}

const collection: ComponentDefinition = {
  type: "data.collection",
  version: 1,
  category: "data",
  title: "Collection",
  description:
    "A persistent set of records of one schema, owned by this application. Records survive reloads and edits to the application. Set exposure to discoverable to let other applications find it (they still need permission to read it).",
  properties: [
    { name: "schema", type: "schema", required: true, title: "Schema", description: "Record type, e.g. clasp.task." },
    {
      name: "exposure",
      type: "enum",
      options: ["private", "discoverable"],
      default: "private",
      title: "Exposure",
      description: "Whether other applications can discover this collection.",
    },
  ],
  inputs: [],
  outputs: recordOutputs,
  events: recordEvents,
  actions: recordActions,
  capabilities: [{ capability: "storage.access", description: "Stores records in the workspace on behalf of this application." }],
  resources: (object) =>
    typeof object.properties.schema === "string" && object.properties.schema !== ""
      ? [
          {
            id: object.id,
            kind: "collection",
            name: object.metadata.name ?? "Collection",
            ...(object.metadata.description ? { description: object.metadata.description } : {}),
            exposure: object.properties.exposure === "discoverable" ? "discoverable" : "private",
            schema: { id: object.properties.schema },
          },
        ]
      : [],
  create: (ctx) => {
    const configured = (): string | undefined => (asText(ctx.props.schema) ? ctx.object.id : undefined);
    const access = collectionAccess(ctx, configured);
    ctx.setOutput("records", []);
    ctx.setOutput("count", 0);
    return {
      start: () => {
        access.load();
        access.watch();
      },
      actions: access.actions,
      dispose: access.stop,
    };
  },
};

const reference: ComponentDefinition = {
  type: "data.reference",
  version: 1,
  category: "data",
  title: "Reference",
  description:
    'A live link to a collection owned by ANOTHER application. It discovers collections of the given schema ("candidates"), is bound to one with the "bind" action, and needs the user to grant access ("requestAccess") before any records flow. Status is one of: unbound, unresolved, needs-access, pending, connected.',
  properties: [
    { name: "schema", type: "schema", title: "Schema", description: "Only collections readable as this schema are offered." },
    { name: "collectionId", type: "resource", title: "Collection", description: "The collection this reference is bound to." },
    { name: "reason", type: "string", title: "Reason", description: "Shown to the user when asking for access." },
    { name: "writable", type: "boolean", default: false, title: "Request write access too" },
  ],
  inputs: [],
  outputs: [
    ...recordOutputs,
    { name: "status", type: "string", description: "unbound | unresolved | needs-access | pending | connected" },
    { name: "candidates", type: "records", description: "Discoverable collections: { id, name, ownerName, schema }." },
    { name: "source", type: "object", description: "The bound collection: { id, name, ownerName }." },
  ],
  events: [...recordEvents, { name: "connected", description: "Access was granted and records are flowing." }],
  actions: [
    ...recordActions,
    { name: "bind", payload: "object", description: "Binds to a collection. Payload: { id } (e.g. a row of candidates)." },
    { name: "unbind", description: "Removes the binding." },
    { name: "requestAccess", description: "Asks the user to grant access to the bound collection." },
  ],
  references: ["collectionId"],
  capabilities: [
    { capability: "collection.query", description: "Reads records of the bound collection (requires a grant from the user)." },
    { capability: "collection.mutate", description: "Only if writable: changes records of the bound collection." },
  ],
  requirements: (object) => {
    const id = object.properties.collectionId;
    if (typeof id !== "string" || id === "") return [];
    const requirements: Array<{ capability: Capability; resource: string; reason: string }> = [
      { capability: "collection.query", resource: id, reason: "Read records" },
    ];
    if (object.properties.writable === true) {
      requirements.push({ capability: "collection.mutate", resource: id, reason: "Change records" });
    }
    return requirements;
  },
  create: (ctx) => {
    const bound = (): string | undefined => asText(ctx.props.collectionId) || undefined;
    let accessWatch: Subscription | undefined;

    const discover = (): void => {
      ctx.run(async () => {
        const schema = asText(ctx.props.schema);
        const found = await ctx.clasp.discover({ kind: "collection", ...(schema ? { schema } : {}) });
        if (!ctx.alive) return;
        const id = bound();
        ctx.setOutput(
          "candidates",
          found
            .filter((resource) => !resource.owned)
            .map((resource) => ({ id: resource.id, name: resource.name, ownerName: resource.ownerName, schema: resource.schema?.id ?? "" })),
        );
        const current = found.find((resource) => resource.id === id);
        ctx.setOutput("source", current ? { id: current.id, name: current.name, ownerName: current.ownerName } : undefined);
      });
    };

    const access = collectionAccess(ctx, bound, {
      onLoaded: () => {
        if (ctx.output("status") !== "connected") {
          ctx.setOutput("status", "connected");
          ctx.emit("connected");
        }
        access.watch();
      },
      onDenied: (error) => {
        ctx.setOutput("error", undefined);
        if (error.code === "NOT_FOUND") {
          ctx.setOutput("status", "unresolved");
          return;
        }
        if (ctx.output("status") !== "pending") ctx.setOutput("status", "needs-access");
        watchAccess();
      },
    });

    /** Learn when the user grants (or revokes) access, without being able to read anything yet. */
    const watchAccess = (): void => {
      const source = bound();
      if (!source || accessWatch?.active) return;
      try {
        accessWatch = ctx.clasp.subscribe({
          source,
          event: "access",
          handler: () => {
            if (ctx.alive) access.load();
          },
        });
      } catch {
        accessWatch = undefined; // not visible to us; nothing to watch
      }
    };

    const sync = (): void => {
      discover();
      if (!bound()) {
        ctx.setOutput("status", "unbound");
        return;
      }
      watchAccess();
      access.load();
    };

    ctx.setOutput("records", []);
    ctx.setOutput("count", 0);
    ctx.setOutput("candidates", []);
    ctx.setOutput("status", bound() ? "needs-access" : "unbound");

    return {
      start: sync,
      actions: {
        ...access.actions,
        refresh: sync,
        bind: (payload) => {
          const id = isJsonObject(payload) ? payload.id : payload;
          if (typeof id === "string" && id !== "" && id !== bound()) ctx.configure({ collectionId: id });
        },
        unbind: () => {
          if (bound()) ctx.configure({ collectionId: null });
        },
        requestAccess: () => {
          const source = bound();
          if (!source) return;
          ctx.setOutput("status", "pending");
          ctx.run(
            async () => {
              const capabilities: Capability[] =
                ctx.props.writable === true ? ["collection.query", "collection.mutate"] : ["collection.query"];
              const reason = asText(ctx.props.reason);
              const decision = await ctx.clasp.requestAccess({ resource: source, capabilities, ...(reason ? { reason } : {}) });
              if (!ctx.alive) return;
              if (decision.granted) access.load();
              else ctx.setOutput("status", "needs-access");
            },
            (error) => {
              ctx.setOutput("status", error.code === "NOT_FOUND" ? "unresolved" : "needs-access");
              ctx.fail(error);
            },
            { background: true },
          );
        },
      },
      dispose: () => {
        access.stop();
        accessWatch?.unsubscribe();
      },
    };
  },
};

const query: ComponentDefinition = {
  type: "data.query",
  version: 1,
  category: "data",
  title: "Query",
  description: "Filters, sorts and limits records in one step, using the same filter syntax as the Universal API.",
  properties: [
    { name: "filter", type: "object", title: "Filter", description: 'e.g. { "completed": false } or { "priority": { "$in": ["high"] } }.' },
    { name: "sort", type: "list", title: "Sort", description: 'List of { "field": string, "direction": "asc" | "desc" }.' },
    { name: "limit", type: "number", title: "Limit" },
  ],
  inputs: [{ name: "records", type: "records" }],
  outputs: [
    { name: "records", type: "records" },
    { name: "count", type: "number" },
  ],
  events: [],
  actions: [],
  create: pure((ctx) => {
    const filter = isJsonObject(ctx.props.filter) ? (ctx.props.filter as RecordFilter) : undefined;
    const sort = Array.isArray(ctx.props.sort) ? (ctx.props.sort.filter(isJsonObject) as unknown as SortSpec[]) : undefined;
    let rows = sortRows(asRows(ctx.input("records")).filter((row) => matchesFilter(row, filter)), sort);
    const limit = asNumber(ctx.props.limit);
    if (limit !== undefined && limit >= 0) rows = rows.slice(0, limit);
    ctx.setOutput("records", rows);
    ctx.setOutput("count", rows.length);
  }),
};

const filter: ComponentDefinition = {
  type: "data.filter",
  version: 1,
  category: "data",
  title: "Filter",
  description:
    'Keeps only the records whose field passes a comparison. Example: field "completed", operator "eq", value false keeps incomplete records. When the value is null or empty text (and the operator needs one) every record passes — so a Tabs "All" option with value null, or an empty search box, turns the filter off.',
  properties: [
    { name: "field", type: "field", required: true, title: "Field" },
    { name: "operator", type: "enum", options: [...OPERATORS], default: "eq", title: "Operator" },
    { name: "value", type: "json", title: "Value", description: "Compared against the field. Can also be supplied through the value input." },
  ],
  inputs: [
    { name: "records", type: "records" },
    { name: "value", type: "any", description: "Overrides the value property." },
    { name: "enabled", type: "boolean", description: "Every record passes while this is false." },
  ],
  outputs: [
    { name: "records", type: "records" },
    { name: "count", type: "number" },
  ],
  events: [],
  actions: [],
  create: pure((ctx) => {
    const rows = asRows(ctx.input("records"));
    const field = asText(ctx.props.field);
    const operator = asText(ctx.props.operator, "eq");
    const value = ctx.input("value");
    // No value (or an empty search box) means "no filter": everything passes.
    const off = ctx.input("enabled") === false || !field || (!isUnary(operator) && (value === undefined || value === null || value === ""));
    const kept = off ? rows : rows.filter((row) => test(operator, row[field], value));
    ctx.setOutput("records", kept);
    ctx.setOutput("count", kept.length);
  }),
};

const sort: ComponentDefinition = {
  type: "data.sort",
  version: 1,
  category: "data",
  title: "Sort",
  description: "Orders records by one field.",
  properties: [
    { name: "field", type: "field", required: true, title: "Field" },
    { name: "direction", type: "enum", options: ["asc", "desc"], default: "asc", title: "Direction" },
  ],
  inputs: [{ name: "records", type: "records" }],
  outputs: [{ name: "records", type: "records" }],
  events: [],
  actions: [],
  create: pure((ctx) => {
    const field = asText(ctx.props.field);
    const rows = asRows(ctx.input("records"));
    ctx.setOutput("records", field ? sortRows(rows, { field, direction: ctx.props.direction === "desc" ? "desc" : "asc" }) : rows);
  }),
};

const transform: ComponentDefinition = {
  type: "data.transform",
  version: 1,
  category: "data",
  title: "Transform",
  description: "Reshapes each record: keep only some fields, rename fields, and set constant fields. The id is always kept.",
  properties: [
    { name: "pick", type: "list", title: "Keep fields", description: "Field names to keep. Empty keeps all." },
    { name: "rename", type: "object", title: "Rename", description: '{ "oldName": "newName" }' },
    { name: "set", type: "object", title: "Set", description: "Constant fields added to every record." },
  ],
  inputs: [{ name: "records", type: "records" }],
  outputs: [{ name: "records", type: "records" }],
  events: [],
  actions: [],
  create: pure((ctx) => {
    const pick = Array.isArray(ctx.props.pick) ? ctx.props.pick.filter((entry): entry is string => typeof entry === "string") : [];
    const rename = isJsonObject(ctx.props.rename) ? ctx.props.rename : {};
    const constants = isJsonObject(ctx.props.set) ? ctx.props.set : {};
    const rows = asRows(ctx.input("records")).map((row) => {
      const next: JsonObject = {};
      for (const [key, value] of Object.entries(row)) {
        if (key !== "id" && pick.length > 0 && !pick.includes(key)) continue;
        const target = typeof rename[key] === "string" && key !== "id" ? (rename[key] as string) : key;
        next[target] = value;
      }
      return { ...next, ...constants };
    });
    ctx.setOutput("records", rows);
  }),
};

const record: ComponentDefinition = {
  type: "data.record",
  version: 1,
  category: "data",
  title: "Record",
  description: "Picks one record out of many — by id, or the first one — and optionally one of its fields.",
  properties: [
    { name: "id", type: "string", title: "Record id" },
    { name: "field", type: "field", title: "Field", description: 'When set, the "value" output carries this field of the record.' },
  ],
  inputs: [
    { name: "records", type: "records" },
    { name: "id", type: "string", description: "Overrides the id property." },
  ],
  outputs: [
    { name: "record", type: "record" },
    { name: "value", type: "any" },
    { name: "found", type: "boolean" },
  ],
  events: [],
  actions: [],
  create: pure((ctx) => {
    const rows = asRows(ctx.input("records"));
    const id = asText(ctx.input("id"));
    const found = id ? rows.find((row) => row.id === id) : rows[0];
    const field = asText(ctx.props.field);
    ctx.setOutput("record", found);
    ctx.setOutput("found", found !== undefined);
    ctx.setOutput("value", found && field ? (found[field] as JsonValue | undefined) : undefined);
  }),
};

const aggregate: ComponentDefinition = {
  type: "data.aggregate",
  version: 1,
  category: "data",
  title: "Computed value",
  description:
    'Computes one number from records: count, sum, average, min or max — optionally only over records matching a condition. Example: operation "count", whereField "completed", whereValue false counts incomplete records.',
  properties: [
    { name: "operation", type: "enum", options: ["count", "sum", "average", "min", "max"], default: "count", title: "Operation" },
    { name: "field", type: "field", title: "Field", description: "Numeric field to aggregate (not needed for count)." },
    { name: "whereField", type: "field", title: "Only where field" },
    { name: "whereOperator", type: "enum", options: [...OPERATORS], default: "eq", title: "Condition" },
    { name: "whereValue", type: "json", title: "Condition value" },
  ],
  inputs: [{ name: "records", type: "records" }],
  outputs: [{ name: "value", type: "number" }],
  events: [],
  actions: [],
  create: pure((ctx) => {
    const whereField = asText(ctx.props.whereField);
    const operator = asText(ctx.props.whereOperator, "eq");
    const rows = asRows(ctx.input("records")).filter((row) => !whereField || test(operator, row[whereField], ctx.props.whereValue));
    const operation = asText(ctx.props.operation, "count");
    if (operation === "count") {
      ctx.setOutput("value", rows.length);
      return;
    }
    const field = asText(ctx.props.field);
    const numbers = rows.map((row) => asNumber(row[field])).filter((value): value is number => value !== undefined);
    if (numbers.length === 0) {
      ctx.setOutput("value", operation === "sum" ? 0 : undefined);
      return;
    }
    const sum = numbers.reduce((total, value) => total + value, 0);
    const result =
      operation === "sum" ? sum : operation === "average" ? sum / numbers.length : operation === "min" ? Math.min(...numbers) : Math.max(...numbers);
    ctx.setOutput("value", result);
  }),
};

export const dataPrimitives: ComponentDefinition[] = [collection, reference, query, filter, sort, transform, record, aggregate];
