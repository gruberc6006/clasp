import { Check, ChevronsUpDown, Database, FileUp, FolderOpen, GraduationCap, LayoutGrid, Palette, Plus, ShieldCheck, Sparkles, Trash2, Workflow } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useStudio } from "../studio/hooks";
import { RenameInput } from "./RenameInput";
import { TutorialCard } from "./Tutorial";
import { Badge, Button, Dialog, Field, INPUT, Menu, MenuItem, SectionTitle, cx } from "./ui";

function Brand(): ReactNode {
  return (
    <div className="px-1">
      <div className="text-[22px] font-semibold leading-none tracking-tight text-ink">
        clasp<span className="text-accent">.</span>
      </div>
      <div className="mt-1.5 text-xs text-ink-faint">Build anything. Connect everything.</div>
    </div>
  );
}

function WorkspaceSwitcher(): ReactNode {
  const studio = useStudio();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  return (
    <>
      <Menu
        trigger={(toggle) => (
          <button
            type="button"
            onClick={toggle}
            data-testid="workspace-switcher"
            className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-left text-sm transition-colors hover:bg-subtle"
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-ink text-[11px] font-semibold text-canvas">
              {(studio.currentEntry?.name ?? "?").charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-ink">{studio.currentEntry?.name ?? "Workspace"}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-ink-faint" />
          </button>
        )}
      >
        {(close) => (
          <div className="w-60">
            <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Workspaces</div>
            {studio.entries.map((entry) => (
              <div key={entry.id} className="group flex items-center">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    void studio.switchWorkspace(entry.id);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-ink hover:bg-subtle"
                >
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.id === studio.currentId && <Check className="size-3.5 text-accent" />}
                </button>
                {studio.entries.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Delete workspace ${entry.name}`}
                    onClick={() => {
                      if (window.confirm(`Delete workspace “${entry.name}” and everything in it? This cannot be undone.`)) {
                        close();
                        void studio.deleteWorkspace(entry.id);
                      }
                    }}
                    className="mr-1 grid size-7 place-items-center rounded-md text-ink-faint opacity-0 hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
            ))}
            <div className="my-1 border-t border-line" />
            <MenuItem
              icon={<Plus className="size-4" />}
              onSelect={() => {
                close();
                setName("");
                setCreating(true);
              }}
            >
              New workspace…
            </MenuItem>
          </div>
        )}
      </Menu>
      {creating && (
        <Dialog
          title="New workspace"
          description="A workspace is a separate place with its own applications, data and permissions."
          onClose={() => setCreating(false)}
          testId="new-workspace-dialog"
          footer={
            <>
              <Button onClick={() => setCreating(false)}>Cancel</Button>
              <Button
                tone="primary"
                onClick={() => {
                  setCreating(false);
                  void studio.createWorkspace(name);
                }}
              >
                Create workspace
              </Button>
            </>
          }
        >
          <Field label="Name" htmlFor="workspace-name">
            <input
              id="workspace-name"
              autoFocus
              className={INPUT}
              value={name}
              placeholder="e.g. Studio B"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setCreating(false);
                  void studio.createWorkspace(name);
                }
              }}
            />
          </Field>
        </Dialog>
      )}
    </>
  );
}

function NewAppMenu(): ReactNode {
  const studio = useStudio();
  const file = useRef<HTMLInputElement>(null);
  return (
    <>
      <Menu
        trigger={(toggle) => (
          <button
            type="button"
            aria-label="New application"
            title="New application"
            data-testid="new-app"
            onClick={toggle}
            className="grid size-6 place-items-center rounded-md text-ink-soft transition-colors hover:bg-subtle hover:text-ink"
          >
            <Plus className="size-4" />
          </button>
        )}
      >
        {(close) => (
          <div className="max-h-[70vh] w-72 overflow-y-auto">
            <MenuItem
              icon={<Plus className="size-4" />}
              hint="Start from an empty graph in Build mode"
              onSelect={() => {
                close();
                void studio.createBlankApp();
              }}
            >
              Blank application
            </MenuItem>
            <MenuItem
              icon={<Sparkles className="size-4" />}
              hint="Describe it and let a local model build it"
              onSelect={() => {
                close();
                void studio.createBlankApp().then((app) => {
                  if (app) studio.setAiOpen(true);
                });
              }}
            >
              Describe with AI
            </MenuItem>
            <MenuItem
              icon={<LayoutGrid className="size-4" />}
              hint="Word processor, terminal, file browser, games and more"
              onSelect={() => {
                close();
                studio.setTemplateGallery(true);
              }}
            >
              From a template…
            </MenuItem>
            <MenuItem
              icon={<FileUp className="size-4" />}
              hint="Open a .clasp.json package"
              onSelect={() => {
                close();
                file.current?.click();
              }}
            >
              Import package…
            </MenuItem>
          </div>
        )}
      </Menu>
      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        className="hidden"
        data-testid="import-file"
        onChange={(event) => {
          const selected = event.target.files?.[0];
          event.target.value = "";
          if (selected) void selected.text().then((text) => studio.importPackageText(text));
        }}
      />
    </>
  );
}

function NavItem(props: {
  active: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  icon: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  testId?: string;
  title?: string;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
      title={props.title}
      data-testid={props.testId}
      aria-current={props.active ? "page" : undefined}
      className={cx(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
        props.active ? "bg-surface font-medium text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-soft hover:bg-subtle hover:text-ink",
      )}
    >
      <span className={cx("grid size-4 shrink-0 place-items-center", props.active && "text-accent")}>{props.icon}</span>
      <span className="min-w-0 flex-1 truncate">{props.children}</span>
      {props.trailing}
    </button>
  );
}

export function Sidebar(): ReactNode {
  const studio = useStudio();
  const workspace = studio.workspace;
  const apps = workspace?.apps() ?? [];
  const pending = workspace?.kernel.permissions.pendingRequests().length ?? 0;
  return (
    <aside className="flex w-64 shrink-0 flex-col gap-5 border-r border-line bg-canvas px-3 py-4">
      <Brand />
      <WorkspaceSwitcher />

      <nav className="flex min-h-0 flex-1 flex-col gap-1.5" aria-label="Applications">
        <div className="px-2.5">
          <SectionTitle action={<NewAppMenu />}>Applications</SectionTitle>
        </div>
        <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto" data-testid="app-list">
          {apps.map((app) => {
            const graph = app.store.graph;
            // A background workflow has objects but no window; an empty app is just empty.
            const objects = Object.values(graph.objects);
            const headless = objects.length > 0 && !objects.some((object) => object.type === "ui.window");
            if (studio.renaming?.appId === app.id && studio.renaming.where === "sidebar") {
              return (
                <div key={app.id} className="flex items-center gap-2.5 px-2.5 py-0.5">
                  <span className="grid size-4 shrink-0 place-items-center text-accent">
                    <LayoutGrid className="size-4" />
                  </span>
                  <RenameInput appId={app.id} name={graph.metadata.name} className="h-7 flex-1 text-sm" />
                </div>
              );
            }
            return (
              <NavItem
                key={app.id}
                active={studio.section === "apps" && studio.app?.id === app.id}
                onClick={() => studio.selectApp(app.id)}
                onDoubleClick={() => studio.startRename(app.id, "sidebar")}
                title="Double-click to rename"
                icon={headless ? <Workflow className="size-4" /> : <LayoutGrid className="size-4" />}
                trailing={app.runtime.status === "halted" ? <Badge tone="danger">halted</Badge> : undefined}
              >
                {graph.metadata.name}
              </NavItem>
            );
          })}
          {apps.length === 0 && studio.status === "ready" && (
            <p className="px-2.5 py-2 text-xs leading-relaxed text-ink-faint">No applications yet. Use + to create or import one.</p>
          )}
        </div>
      </nav>

      <TutorialCard />

      <nav className="flex flex-col gap-0.5" aria-label="Workspace">
        <div className="px-2.5 pb-1.5">
          <SectionTitle>Workspace</SectionTitle>
        </div>
        <NavItem active={studio.tutorialPickerOpen} onClick={() => studio.setTutorialPicker(true)} icon={<GraduationCap className="size-4" />} testId="nav-learn">
          Learn
        </NavItem>
        <NavItem active={studio.section === "files"} onClick={() => studio.setSection("files")} icon={<FolderOpen className="size-4" />} testId="nav-files">
          Files
        </NavItem>
        <NavItem active={studio.section === "data"} onClick={() => studio.setSection("data")} icon={<Database className="size-4" />} testId="nav-data">
          Data
        </NavItem>
        <NavItem
          active={studio.section === "permissions"}
          onClick={() => studio.setSection("permissions")}
          icon={<ShieldCheck className="size-4" />}
          trailing={pending > 0 ? <Badge tone="accent">{pending}</Badge> : undefined}
          testId="nav-permissions"
        >
          Permissions
        </NavItem>
        <NavItem active={studio.appearanceOpen} onClick={() => studio.setAppearanceOpen(true)} icon={<Palette className="size-4" />} testId="nav-appearance">
          Appearance
        </NavItem>
      </nav>
    </aside>
  );
}
