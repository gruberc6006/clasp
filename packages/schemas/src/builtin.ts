import { SchemaRegistry, type SchemaDefinition } from "./registry";

/**
 * The common types every Clasp workspace understands out of the box.
 * Applications may register their own schemas (ideally extending these).
 */
export const BUILTIN_SCHEMAS: readonly SchemaDefinition[] = [
  {
    id: "clasp.project",
    version: 1,
    title: "Project",
    description: "A body of work that groups tasks, notes and documents.",
    fields: {
      name: { type: "string", required: true, minLength: 1, title: "Name" },
      description: { type: "string", title: "Description" },
      status: { type: "enum", values: ["planned", "active", "paused", "done"], default: "active", title: "Status" },
    },
  },
  {
    id: "clasp.task",
    version: 1,
    title: "Task",
    description: "Something to be done.",
    fields: {
      title: { type: "string", required: true, minLength: 1, title: "Title" },
      completed: { type: "boolean", default: false, title: "Completed" },
      notes: { type: "string", title: "Notes" },
      dueDate: { type: "date", title: "Due date" },
      priority: { type: "enum", values: ["low", "medium", "high"], title: "Priority" },
      project: { type: "reference", ref: "clasp.project", title: "Project" },
    },
  },
  {
    id: "clasp.note",
    version: 1,
    title: "Note",
    description: "Free-form text.",
    fields: {
      title: { type: "string", title: "Title" },
      body: { type: "string", required: true, title: "Body" },
      tags: { type: "list", items: "string", default: [], title: "Tags" },
      project: { type: "reference", ref: "clasp.project", title: "Project" },
    },
  },
  {
    id: "clasp.event",
    version: 1,
    title: "Event",
    description: "Something that happens at a point in time.",
    fields: {
      title: { type: "string", required: true, minLength: 1, title: "Title" },
      start: { type: "datetime", required: true, title: "Starts" },
      end: { type: "datetime", title: "Ends" },
      location: { type: "string", title: "Location" },
      attendees: { type: "list", items: "reference", default: [], title: "Attendees", description: "Record ids of clasp.contact records." },
    },
  },
  {
    id: "clasp.contact",
    version: 1,
    title: "Contact",
    description: "A person or organization.",
    fields: {
      name: { type: "string", required: true, minLength: 1, title: "Name" },
      email: { type: "string", title: "Email" },
      phone: { type: "string", title: "Phone" },
      organization: { type: "string", title: "Organization" },
    },
  },
  {
    id: "clasp.document",
    version: 1,
    title: "Document",
    description: "A titled piece of content.",
    fields: {
      title: { type: "string", required: true, minLength: 1, title: "Title" },
      content: { type: "string", default: "", title: "Content" },
      mimeType: { type: "string", default: "text/plain", title: "Type" },
      author: { type: "reference", ref: "clasp.contact", title: "Author" },
      project: { type: "reference", ref: "clasp.project", title: "Project" },
    },
  },
  {
    id: "clasp.score",
    version: 1,
    title: "Score",
    description: "The result of one game.",
    fields: {
      game: { type: "string", required: true, minLength: 1, title: "Game" },
      score: { type: "number", default: 0, title: "Score" },
      won: { type: "boolean", default: false, title: "Won" },
      summary: { type: "string", default: "", title: "Summary" },
      playedOn: { type: "string", default: "", title: "Played on" },
    },
  },
];

export const BUILTIN_SCHEMA_IDS: readonly string[] = BUILTIN_SCHEMAS.map((schema) => schema.id);

/** A registry preloaded with the built-in schemas. */
export function createSchemaRegistry(extra: readonly SchemaDefinition[] = []): SchemaRegistry {
  const registry = new SchemaRegistry();
  for (const schema of [...BUILTIN_SCHEMAS, ...extra]) registry.register(schema);
  return registry;
}
