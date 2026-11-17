import type { FileEntry } from "@clasp/files";
import { Download, FileMusic, FileSpreadsheet, FileText, FolderOpen, Image, Pencil, ShieldOff, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { downloadText, useStudio } from "../studio/hooks";
import { Badge, Button, Dialog, EmptyState, INPUT, cx } from "./ui";

const KIND_LABELS: Record<string, string> = { text: "text document", spreadsheet: "spreadsheet", drawing: "drawing", sequencer: "beat" };

export function kindIcon(kind: string): ReactNode {
  switch (kind) {
    case "spreadsheet":
      return <FileSpreadsheet className="size-4" />;
    case "drawing":
      return <Image className="size-4" />;
    case "sequencer":
      return <FileMusic className="size-4" />;
    default:
      return <FileText className="size-4" />;
  }
}

function when(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  return date.toDateString() === today.toDateString() ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString();
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function FileRow(props: { file: FileEntry; selected: boolean; onSelect: () => void; onActivate?: () => void }): ReactNode {
  return (
    <li>
      <button
        type="button"
        data-testid="file-choice"
        data-name={props.file.name}
        aria-pressed={props.selected}
        onClick={props.onSelect}
        onDoubleClick={props.onActivate}
        className={cx(
          "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
          props.selected ? "bg-accent-soft text-accent-ink" : "text-ink hover:bg-subtle",
        )}
      >
        <span className="text-ink-soft">{kindIcon(props.file.kind)}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{props.file.name}</span>
        <span className="shrink-0 text-xs text-ink-faint">{when(props.file.updatedAt)}</span>
      </button>
    </li>
  );
}

/**
 * The Open and Save As dialogs. Whatever file the user chooses here is the
 * only one the asking application receives.
 */
export function FileDialog(): ReactNode {
  const studio = useStudio();
  const pending = studio.fileDialog;
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const upload = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSelected(undefined);
    setName(pending?.mode === "save" ? pending.request.suggestedName : "");
  }, [pending]);

  if (!pending || !studio.files) return null;
  const kind = pending.request.kind;
  const label = KIND_LABELS[kind] ?? "file";
  const files = studio.files.list(kind);
  const cancel = (): void => studio.answerFileDialog(undefined);

  if (pending.mode === "open") {
    const open = (fileId: string | undefined): void => {
      if (fileId) studio.answerFileDialog(fileId);
    };
    return (
      <Dialog
        title={`Open a ${label}`}
        description={
          <>
            <span className="font-medium text-ink">{pending.request.appName}</span> will be able to open and save the file you choose — and only that file.
          </>
        }
        onClose={cancel}
        width="max-w-lg"
        testId="file-dialog"
        footer={
          <>
            <Button icon={<Upload className="size-3.5" />} onClick={() => upload.current?.click()} className="mr-auto">
              From this computer…
            </Button>
            <Button onClick={cancel}>Cancel</Button>
            <Button tone="primary" disabled={!selected} onClick={() => open(selected)} data-testid="file-dialog-confirm">
              Open
            </Button>
          </>
        }
      >
        {files.length === 0 ? (
          <EmptyState icon={<FolderOpen className="size-5" />} title={`No ${label}s yet`}>
            Save one from an application, or bring one in from this computer.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {files.map((file) => (
              <FileRow key={file.id} file={file} selected={selected === file.id} onSelect={() => setSelected(file.id)} onActivate={() => open(file.id)} />
            ))}
          </ul>
        )}
        <input
          ref={upload}
          type="file"
          className="hidden"
          data-testid="file-dialog-upload"
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            event.target.value = "";
            if (chosen) void studio.importFromDisk(chosen).then((id) => id && setSelected(id));
          }}
        />
      </Dialog>
    );
  }

  const trimmed = name.trim();
  const existing = files.find((file) => file.name === trimmed);
  const save = (): void => {
    if (!trimmed) return;
    studio.answerFileDialog(existing ? { name: trimmed, replace: existing.id } : { name: trimmed });
  };
  return (
    <Dialog
      title="Save As"
      description={
        <>
          Save <span className="font-medium text-ink">{pending.request.appName}</span>’s {label} in your files.
        </>
      }
      onClose={cancel}
      width="max-w-lg"
      testId="file-dialog"
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button tone={existing ? "danger" : "primary"} disabled={!trimmed} onClick={save} data-testid="file-dialog-confirm">
            {existing ? "Replace" : "Save"}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-ink-soft">Name</span>
        <input
          autoFocus
          className={INPUT}
          value={name}
          aria-label="File name"
          data-testid="file-dialog-name"
          onFocus={(event) => event.target.select()}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
        />
      </label>
      {existing && <p className="mt-2 text-xs text-danger">A {label} with this name exists; saving replaces it.</p>}
      {files.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium text-ink-soft">Existing {label}s</div>
          <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
            {files.map((file) => (
              <FileRow key={file.id} file={file} selected={existing?.id === file.id} onSelect={() => setName(file.name)} />
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}

/** The user's own view of the workspace's files. */
export function FilesView(): ReactNode {
  const studio = useStudio();
  const files = studio.files?.list() ?? [];
  const upload = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | undefined>(undefined);
  const appName = (id: string): string => studio.workspace?.app(id)?.store.graph.metadata.name ?? "a removed application";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="files-view">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-ink">Files</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-soft">
              Documents saved by your applications. An application can open only the files you pick for it in a file dialog, and you can take that back here.
            </p>
          </div>
          <Button icon={<Upload className="size-3.5" />} onClick={() => upload.current?.click()} data-testid="files-upload">
            From this computer…
          </Button>
          <input
            ref={upload}
            type="file"
            className="hidden"
            data-testid="files-upload-input"
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              event.target.value = "";
              if (chosen) void studio.importFromDisk(chosen);
            }}
          />
        </header>
        {files.length === 0 ? (
          <EmptyState icon={<FolderOpen className="size-5" />} title="No files yet">
            Use Save in Notes, Text Editor, Word Processor, Spreadsheet, Sketchpad or Beat Maker — or bring files in from this computer (.txt, .md, .csv, or Clasp documents).
          </EmptyState>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-line bg-surface">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-subtle/60 text-xs font-medium uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Kind</th>
                  <th className="px-4 py-2.5">Size</th>
                  <th className="px-4 py-2.5">Modified</th>
                  <th className="px-4 py-2.5">Open in</th>
                  <th className="w-36" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {files.map((file) => (
                  <tr key={file.id} data-testid="file-row" data-name={file.name} className="group">
                    <td className="px-4 py-2.5">
                      {renaming?.id === file.id ? (
                        <input
                          autoFocus
                          aria-label="New name"
                          className={cx(INPUT, "h-7")}
                          value={renaming.name}
                          onChange={(event) => setRenaming({ id: file.id, name: event.target.value })}
                          onBlur={() => {
                            const next = renaming.name.trim();
                            setRenaming(undefined);
                            if (next && next !== file.name) void studio.files?.rename(file.id, next).catch((error: unknown) => studio.reportError("Could not rename", error));
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                            if (event.key === "Escape") setRenaming(undefined);
                          }}
                        />
                      ) : (
                        <span className="flex items-center gap-2.5 font-medium text-ink">
                          <span className="text-ink-soft">{kindIcon(file.kind)}</span>
                          {file.name}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-ink-soft">{KIND_LABELS[file.kind] ?? file.kind}</td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-soft">{size(file.size)}</td>
                    <td className="px-4 py-2.5 text-ink-soft">{when(file.updatedAt)}</td>
                    <td className="px-4 py-2.5">
                      {file.access.length === 0 ? (
                        <span className="text-xs text-ink-faint">No application</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {file.access.map((id) => (
                            <Badge key={id}>{appName(id)}</Badge>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2.5">
                      <span className="flex justify-end gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                        <button
                          type="button"
                          title="Save a copy on this computer"
                          aria-label={`Download ${file.name}`}
                          className="grid size-7 place-items-center rounded-md text-ink-soft hover:bg-subtle hover:text-ink"
                          onClick={() => {
                            const copy = studio.exportToDisk(file.id);
                            if (copy) downloadText(copy.fileName, copy.text, copy.mimeType);
                          }}
                        >
                          <Download className="size-4" />
                        </button>
                        <button
                          type="button"
                          title="Rename"
                          aria-label={`Rename ${file.name}`}
                          className="grid size-7 place-items-center rounded-md text-ink-soft hover:bg-subtle hover:text-ink"
                          onClick={() => setRenaming({ id: file.id, name: file.name })}
                        >
                          <Pencil className="size-4" />
                        </button>
                        <button
                          type="button"
                          title="Take back every application's access"
                          aria-label={`Revoke access to ${file.name}`}
                          disabled={file.access.length === 0}
                          className="grid size-7 place-items-center rounded-md text-ink-soft hover:bg-subtle hover:text-ink disabled:opacity-30"
                          onClick={() => void studio.files?.revokeAccess(file.id)}
                        >
                          <ShieldOff className="size-4" />
                        </button>
                        <button
                          type="button"
                          title="Delete"
                          aria-label={`Delete ${file.name}`}
                          className="grid size-7 place-items-center rounded-md text-ink-soft hover:bg-danger-soft hover:text-danger"
                          onClick={() => {
                            if (window.confirm(`Delete “${file.name}”? This cannot be undone.`)) void studio.files?.remove(file.id);
                          }}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
