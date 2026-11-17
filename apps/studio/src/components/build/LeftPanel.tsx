import { childrenOf, sortObjects, type ClaspGraph, type ClaspObject } from "@clasp/core";
import { useGraph } from "@clasp/renderer-react";
import { COMPONENT_CATEGORIES, type AppHandle, type ComponentCategory, type ComponentRegistry } from "@clasp/runtime";
import { Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useStudio, useWorkspace } from "../../studio/hooks";
import { INPUT, Segmented, cx } from "../ui";
import { CATEGORY_DOT } from "./GraphCanvas";

const CATEGORY_LABELS: Record<ComponentCategory, string> = {
  interface: "Interface",
  data: "Data",
  logic: "Logic",
  workflow: "Workflow",
  network: "Network",
  game: "Games",
  composition: "Composition",
};

function Library({ onAdd }: { onAdd: (type: string) => void }): ReactNode {
  const workspace = useWorkspace();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = workspace.registry
    .list()
    .filter((definition) => !needle || `${definition.title} ${definition.type} ${definition.description}`.toLowerCase().includes(needle));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative px-3 pb-3">
        <Search className="pointer-events-none absolute left-5.5 top-2.5 size-3.5 text-ink-faint" />
        <input
          className={cx(INPUT, "pl-8")}
          placeholder="Search components"
          aria-label="Search components"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4" data-testid="component-library">
        {COMPONENT_CATEGORIES.map((category) => {
          const entries = matches.filter((definition) => definition.category === category);
          if (entries.length === 0) return null;
          return (
            <section key={category} className="mb-4">
              <h3 className="mb-1 flex items-center gap-2 px-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                <span className={cx("size-1.5 rounded-full", CATEGORY_DOT[category])} />
                {CATEGORY_LABELS[category]}
              </h3>
              {entries.map((definition) => (
                <button
                  key={definition.type}
                  type="button"
                  title={definition.description}
                  data-testid={`library-${definition.type}`}
                  onClick={() => onAdd(definition.type)}
                  className="group flex w-full flex-col rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-subtle"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-ink">{definition.title}</span>
                    <code className="shrink-0 text-[10px] text-ink-faint">{definition.type}</code>
                  </span>
                  <span className="line-clamp-2 text-xs leading-snug text-ink-soft">{definition.description}</span>
                </button>
              ))}
            </section>
          );
        })}
        {matches.length === 0 && <p className="px-2 text-sm text-ink-faint">No component matches “{query}”.</p>}
      </div>
    </div>
  );
}

function OutlineRow(props: { object: ClaspObject; depth: number; registry: ComponentRegistry; selected: boolean; onFocus: (id: string) => void }): ReactNode {
  const definition = props.registry.get(props.object.type);
  return (
    <button
      type="button"
      data-testid="outline-row"
      data-name={props.object.metadata.name ?? ""}
      onClick={() => props.onFocus(props.object.id)}
      style={{ paddingLeft: 8 + props.depth * 14 }}
      className={cx(
        "flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-sm transition-colors",
        props.selected ? "bg-accent-soft text-accent-ink" : "text-ink hover:bg-subtle",
      )}
    >
      <span className={cx("size-1.5 shrink-0 rounded-full", CATEGORY_DOT[definition?.category ?? "unknown"])} />
      <span className="min-w-0 flex-1 truncate">{props.object.metadata.name ?? definition?.title ?? props.object.type}</span>
      <span className="shrink-0 truncate text-[10px] text-ink-faint">{props.object.type.split(".").pop()}</span>
    </button>
  );
}

function Outline({ graph, onFocus }: { graph: ClaspGraph; onFocus: (id: string) => void }): ReactNode {
  const studio = useStudio();
  const registry = useWorkspace().registry;
  const tree: ReactNode[] = [];
  const visit = (object: ClaspObject, depth: number): void => {
    tree.push(<OutlineRow key={object.id} object={object} depth={depth} registry={registry} selected={studio.selectedObjectId === object.id} onFocus={onFocus} />);
    for (const child of childrenOf(graph, object.id)) visit(child, depth + 1);
  };
  const roots = childrenOf(graph, undefined);
  const visual = roots.filter((object) => registry.get(object.type)?.category === "interface" || childrenOf(graph, object.id).length > 0);
  for (const root of visual) visit(root, 0);
  const rest = sortObjects(roots.filter((object) => !visual.includes(object)));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4" data-testid="outline">
      {roots.length === 0 && <p className="px-2 text-sm text-ink-faint">Nothing yet. Add a component from the library.</p>}
      {tree.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-1 px-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Interface</h3>
          {tree}
        </section>
      )}
      {rest.length > 0 && (
        <section>
          <h3 className="mb-1 px-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Data & logic</h3>
          {rest.map((object) => (
            <OutlineRow key={object.id} object={object} depth={0} registry={registry} selected={studio.selectedObjectId === object.id} onFocus={onFocus} />
          ))}
        </section>
      )}
    </div>
  );
}

export function LeftPanel(props: { app: AppHandle; onAdd: (type: string) => void; onFocus: (id: string) => void }): ReactNode {
  const graph = useGraph(props.app.store);
  const [tab, setTab] = useState<"library" | "outline">("library");
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-surface">
      <div className="px-3 py-3">
        <Segmented
          label="Panel"
          value={tab}
          onChange={setTab}
          options={[
            { value: "library", label: "Components" },
            { value: "outline", label: `Outline · ${Object.keys(graph.objects).length}` },
          ]}
        />
      </div>
      {tab === "library" ? <Library onAdd={props.onAdd} /> : <Outline graph={graph} onFocus={props.onFocus} />}
    </aside>
  );
}
