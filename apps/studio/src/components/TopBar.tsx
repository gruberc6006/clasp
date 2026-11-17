import { useGraph } from "@clasp/renderer-react";
import type { AppHandle } from "@clasp/runtime";
import { Blocks, Download, GitFork, ListChecks, MoreHorizontal, Pencil, Play, Redo2, RotateCcw, Sparkles, Trash2, Undo2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { downloadText, useStudio } from "../studio/hooks";
import type { Mode } from "../studio/session";
import { RenameInput } from "./RenameInput";
import { Badge, Button, CommitInput, Dialog, IconButton, Menu, MenuItem, Segmented, Toggle } from "./ui";

function DeleteDialog({ app, onClose }: { app: AppHandle; onClose: () => void }): ReactNode {
  const studio = useStudio();
  const [deleteData, setDeleteData] = useState(false);
  const name = app.store.graph.metadata.name;
  return (
    <Dialog
      title={`Delete “${name}”?`}
      description="The application, its history and every permission involving it are removed."
      onClose={onClose}
      testId="delete-app-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="danger"
            onClick={() => {
              onClose();
              void studio.deleteApp(app.id, deleteData);
            }}
          >
            Delete application
          </Button>
        </>
      }
    >
      <label className="flex items-start gap-3 rounded-xl border border-line p-3.5">
        <Toggle checked={deleteData} onChange={setDeleteData} label="Also delete its data" />
        <span className="text-sm">
          <span className="block font-medium text-ink">Also delete its data</span>
          <span className="block text-ink-soft">
            {deleteData ? "Records in its collections are erased permanently." : "Records in its collections are kept in the workspace (see Data)."}
          </span>
        </span>
      </label>
    </Dialog>
  );
}

export function TopBar({ app }: { app: AppHandle }): ReactNode {
  const studio = useStudio();
  const graph = useGraph(app.store);
  const [deleting, setDeleting] = useState(false);
  const building = studio.mode === "build";

  const exportApp = async (): Promise<void> => {
    const file = await studio.exportApp(app.id);
    if (!file) return;
    downloadText(file.fileName, file.text);
    studio.toast({ tone: "success", title: "Exported", message: `${file.fileName} contains the application's definition — no records and no permissions.` });
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {studio.renaming?.appId === app.id && studio.renaming.where === "title" ? (
          <RenameInput key={app.id} appId={app.id} name={graph.metadata.name} className="h-8 w-64 text-[15px] font-semibold tracking-tight" />
        ) : building ? (
          <CommitInput
            label="Application name"
            value={graph.metadata.name}
            onCommit={(name) => studio.renameApp(app.id, name)}
            className="h-8 max-w-64 border-transparent bg-transparent px-2 text-[15px] font-semibold tracking-tight hover:border-line"
          />
        ) : (
          <h1 className="min-w-0 text-[15px] font-semibold tracking-tight text-ink" data-testid="app-title">
            <button
              type="button"
              title="Rename"
              data-testid="app-title-button"
              onClick={() => studio.startRename(app.id, "title")}
              className="group flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 hover:bg-subtle"
            >
              <span className="truncate">{graph.metadata.name}</span>
              <Pencil className="size-3.5 shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
            </button>
          </h1>
        )}
        {graph.metadata.origin && (
          <Badge title={`Derived from “${graph.metadata.origin.name ?? graph.metadata.origin.appId}” at revision ${graph.metadata.origin.version}`}>
            <GitFork className="mr-1 size-3" />
            from {graph.metadata.origin.name ?? "another app"}
          </Badge>
        )}
        {app.runtime.status === "halted" && (
          <Button size="sm" tone="secondary" icon={<RotateCcw className="size-3.5" />} onClick={() => app.runtime.restart()}>
            Restart (halted)
          </Button>
        )}
      </div>

      <Segmented<Mode>
        label="Mode"
        value={studio.mode}
        onChange={(mode) => studio.setMode(mode)}
        options={[
          { value: "use", label: "Use", icon: <Play className="size-3.5" /> },
          { value: "build", label: "Build", icon: <Blocks className="size-3.5" /> },
        ]}
      />

      <div className="flex flex-1 items-center justify-end gap-1">
        {building && (
          <>
            <IconButton label={app.store.undoLabel ? `Undo: ${app.store.undoLabel}` : "Undo"} disabled={!app.store.canUndo} onClick={() => app.store.undo()}>
              <Undo2 className="size-4" />
            </IconButton>
            <IconButton label="Redo" disabled={!app.store.canRedo} onClick={() => app.store.redo()}>
              <Redo2 className="size-4" />
            </IconButton>
            <span className="mx-1 h-5 w-px bg-line" />
          </>
        )}
        <Button
          tone={studio.featuresOpen ? "dark" : "secondary"}
          icon={<ListChecks className="size-3.5" />}
          onClick={() => studio.setFeaturesOpen(!studio.featuresOpen)}
          data-testid="features-toggle"
        >
          Features
        </Button>
        <Button
          tone={studio.aiOpen ? "dark" : "secondary"}
          icon={<Sparkles className="size-3.5" />}
          onClick={() => studio.setAiOpen(!studio.aiOpen)}
          data-testid="ai-toggle"
        >
          AI
        </Button>
        <Button icon={<Download className="size-3.5" />} onClick={() => void exportApp()} data-testid="export-app">
          Export
        </Button>
        <Menu
          align="right"
          trigger={(toggle) => (
            <IconButton label="More actions" onClick={toggle} data-testid="app-menu">
              <MoreHorizontal className="size-4" />
            </IconButton>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<Pencil className="size-4" />}
                hint="Give the application a new name"
                onSelect={() => {
                  close();
                  studio.startRename(app.id, "title");
                }}
              >
                Rename
              </MenuItem>
              <MenuItem
                icon={<GitFork className="size-4" />}
                hint="An independent copy with its own data"
                onSelect={() => {
                  close();
                  void studio.forkApp(app.id);
                }}
              >
                Fork
              </MenuItem>
              <MenuItem
                icon={<Trash2 className="size-4" />}
                tone="danger"
                onSelect={() => {
                  close();
                  setDeleting(true);
                }}
              >
                Delete…
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
      {deleting && <DeleteDialog app={app} onClose={() => setDeleting(false)} />}
    </header>
  );
}
