import { applyOperations, createGraph, type ClaspGraph, type TypeCatalog } from "@clasp/core";
import { compileFeatures, type FeaturePlan } from "@clasp/features";
import { documentFeature } from "@clasp/files";
import type { ComponentRegistry } from "@clasp/runtime";
import { createSchemaRegistry } from "@clasp/schemas";

/**
 * Applications described only by their features. The feature compiler — the
 * same one the AI uses — turns each description into a graph.
 */
export function buildFromFeatures(name: string, description: string, plan: FeaturePlan, registry: ComponentRegistry): ClaspGraph {
  const graph = createGraph({ name, description });
  const compiled = compileFeatures(plan, { graph, registry, schemas: createSchemaRegistry() }, [documentFeature]);
  if (compiled.issues.length > 0) throw new Error(`${name}: ${compiled.issues.join(" ")}`);
  return applyOperations(graph, compiled.operations, { catalog: registry }).graph;
}

export const DOCUMENT_APPS: Array<{ id: string; name: string; description: string; plan: FeaturePlan }> = [
  {
    id: "notes",
    name: "Notes",
    description: "A plain-text editor that opens and saves files.",
    plan: { title: "Notes", features: [{ kind: "document", editor: "text", files: true, title: "Untitled note" }] },
  },
  {
    id: "spreadsheet",
    name: "Spreadsheet",
    description: "A grid with formulas (SUM, AVERAGE, IF, …) that opens and saves files.",
    plan: { title: "Spreadsheet", features: [{ kind: "document", editor: "spreadsheet", files: true, title: "Untitled sheet" }] },
  },
  {
    id: "sketchpad",
    name: "Sketchpad",
    description: "Draw with a pen, colours and an eraser; open and save drawings.",
    plan: { title: "Sketchpad", features: [{ kind: "document", editor: "drawing", files: true, title: "Untitled drawing" }] },
  },
  {
    id: "calendar",
    name: "Calendar",
    description: "A month calendar of events; click a day to add an event on it.",
    plan: {
      title: "Calendar",
      features: [
        { kind: "add", entity: "Event", fields: ["title", "start", "location"], button: "Add event" },
        { kind: "calendar", entity: "Event", field: "start" },
        { kind: "sort", entity: "Event", field: "start" },
        { kind: "list", entity: "Event", fields: ["title", "start"], name: "Upcoming events" },
        { kind: "share", entity: "Event" },
      ],
    },
  },
  {
    id: "beat-maker",
    name: "Beat Maker",
    description: "A step sequencer with drums, bass and chimes; open and save patterns.",
    plan: { title: "Beat Maker", features: [{ kind: "document", editor: "sequencer", files: true, title: "Untitled beat" }] },
  },
];

export function documentAppTemplate(entry: (typeof DOCUMENT_APPS)[number]) {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    build: (catalog?: TypeCatalog) => buildFromFeatures(entry.name, entry.description, entry.plan, catalog as ComponentRegistry),
  };
}
