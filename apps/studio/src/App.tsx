import { LayoutGrid } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { AiPanel } from "./components/AiPanel";
import { FeaturePanel } from "./components/FeaturePanel";
import { BuildMode } from "./components/BuildMode";
import { DataExplorer } from "./components/DataExplorer";
import { Desktop } from "./components/Desktop";
import { FileDialog, FilesView } from "./components/Files";
import { Highlighter, TutorialPicker } from "./components/Tutorial";
import { TemplateGallery } from "./components/TemplateGallery";
import { AppearanceDialog, AppearanceEffect } from "./components/Appearance";
import { PermissionPrompt, Toasts } from "./components/Overlays";
import { PermissionManager } from "./components/PermissionManager";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { Button, EmptyState } from "./components/ui";
import { StudioContext, useStudio } from "./studio/hooks";
import { StudioSession } from "./studio/session";

function Main(): ReactNode {
  const studio = useStudio();
  if (studio.status === "loading") {
    return (
      <div className="grid flex-1 place-items-center" data-testid="loading">
        <div className="flex flex-col items-center gap-3 text-ink-faint">
          <div className="size-5 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
          <span className="text-sm">Opening workspace…</span>
        </div>
      </div>
    );
  }
  if (studio.status === "error") {
    return (
      <div className="grid flex-1 place-items-center">
        <EmptyState title="This workspace could not be opened" action={<Button onClick={() => void studio.retry()}>Try again</Button>}>
          {studio.error}
        </EmptyState>
      </div>
    );
  }
  if (studio.section === "data") return <DataExplorer />;
  if (studio.section === "permissions") return <PermissionManager />;
  if (studio.section === "files") return <FilesView />;

  const app = studio.app;
  if (!app) {
    return (
      <div className="clasp-dots grid flex-1 place-items-center">
        <EmptyState
          icon={<LayoutGrid className="size-5" />}
          title="Nothing here yet"
          action={
            <div className="flex gap-2">
              <Button tone="primary" onClick={() => void studio.createBlankApp()}>
                New application
              </Button>
              <Button onClick={() => void studio.createFromTemplate("task-manager")}>Add Task Manager</Button>
            </div>
          }
        >
          Create an application, start from a template, or import a package with the + button.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TopBar key={app.id} app={app} />
      <div className="flex min-h-0 flex-1">
        {/* Both modes read the same graphs and the same running runtimes, so switching loses nothing.
            The desktop shows every application; Build mode and the AI panel act on the selected one. */}
        {/* Keys must differ between siblings: a shared key leaves stale editors behind when the app changes. */}
        {studio.mode === "use" ? <Desktop /> : <BuildMode key={`build:${app.id}`} app={app} />}
        {studio.aiOpen && <AiPanel key={`ai:${app.id}`} app={app} />}
        {studio.featuresOpen && <FeaturePanel key={`features:${app.id}`} app={app} />}
      </div>
    </div>
  );
}

export function App(): ReactNode {
  const [session] = useState(() => new StudioSession());
  useEffect(() => {
    void session.boot();
    // Handy for debugging and for browser tests.
    (window as unknown as { clasp?: StudioSession }).clasp = session;
  }, [session]);
  return (
    <StudioContext.Provider value={session}>
      <div className="flex h-full overflow-hidden bg-canvas text-ink">
        <Sidebar />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
          <Main />
        </main>
        <PermissionPrompt />
        <FileDialog />
        <TutorialPicker />
        <TemplateGallery />
        <AppearanceDialog />
        <AppearanceEffect />
        <Highlighter />
        <Toasts />
      </div>
    </StudioContext.Provider>
  );
}
