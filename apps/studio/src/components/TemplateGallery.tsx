import { TEMPLATE_CATEGORIES, templates, type AppTemplate } from "@clasp/examples";
import {
  Activity,
  Bell,
  BookOpen,
  Brush,
  Calculator,
  CalendarDays,
  CheckSquare,
  Clock,
  Code2,
  FileText,
  FolderOpen,
  Hash,
  Kanban,
  LayoutDashboard,
  LayoutGrid,
  Layers,
  MessagesSquare,
  Music,
  Search,
  StickyNote,
  Table2,
  Terminal,
  Type,
  Users,
  Worm,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useStudio } from "../studio/hooks";
import { Dialog, INPUT, cx } from "./ui";

const ICONS: Record<string, ReactNode> = {
  "task-manager": <CheckSquare className="size-5" />,
  notes: <StickyNote className="size-5" />,
  spreadsheet: <Table2 className="size-5" />,
  sketchpad: <Brush className="size-5" />,
  calendar: <CalendarDays className="size-5" />,
  "beat-maker": <Music className="size-5" />,
  "word-processor": <FileText className="size-5" />,
  "text-editor": <Code2 className="size-5" />,
  kanban: <Kanban className="size-5" />,
  contacts: <Users className="size-5" />,
  journal: <BookOpen className="size-5" />,
  terminal: <Terminal className="size-5" />,
  calculator: <Calculator className="size-5" />,
  "file-browser": <FolderOpen className="size-5" />,
  "system-monitor": <Activity className="size-5" />,
  clock: <Clock className="size-5" />,
  "socket-chat": <MessagesSquare className="size-5" />,
  "tic-tac-toe": <Hash className="size-5" />,
  pairs: <Layers className="size-5" />,
  "word-guess": <Type className="size-5" />,
  glowworm: <Worm className="size-5" />,
  "task-dashboard": <LayoutDashboard className="size-5" />,
  "task-notifier": <Bell className="size-5" />,
};

const TINT: Record<string, string> = {
  Productivity: "bg-accent-soft text-accent-ink",
  Tools: "bg-[#2b7bd0]/15 text-[#2b7bd0]",
  Creative: "bg-warning-soft text-warning",
  Games: "bg-[#d0457f]/15 text-[#d0457f]",
  Examples: "bg-success-soft text-success",
};

function Card({ template, onPick }: { template: AppTemplate; onPick: () => void }): ReactNode {
  return (
    <button
      type="button"
      data-testid="template-card"
      data-template={template.id}
      aria-label={template.name}
      onClick={onPick}
      className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3 text-left transition-all hover:-translate-y-0.5 hover:border-accent hover:shadow-pop focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className={cx("grid size-10 shrink-0 place-items-center rounded-xl", TINT[template.category])}>{ICONS[template.id] ?? <LayoutGrid className="size-5" />}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">{template.name}</span>
        <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-ink-soft">{template.description}</span>
      </span>
    </button>
  );
}

/** Every template, by category. Picking one adds that application to the workspace. */
export function TemplateGallery(): ReactNode {
  const studio = useStudio();
  // Mounted only while open, so every opening starts with an empty search.
  return studio.templateGalleryOpen ? <Gallery /> : null;
}

function Gallery(): ReactNode {
  const studio = useStudio();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = templates.filter((template) => !needle || `${template.name} ${template.description} ${template.category}`.toLowerCase().includes(needle));
  const pick = (template: AppTemplate): void => {
    studio.setTemplateGallery(false);
    void studio.createFromTemplate(template.id);
  };
  return (
    <Dialog
      title="New application from a template"
      description="Each template is an ordinary application you can open in Build mode and change."
      onClose={() => studio.setTemplateGallery(false)}
      width="max-w-3xl"
      testId="template-gallery"
    >
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-faint" />
        <input autoFocus className={cx(INPUT, "pl-8")} placeholder="Search templates" aria-label="Search templates" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {matches.length === 0 && <p className="py-6 text-center text-sm text-ink-faint">No template matches “{query}”.</p>}
      {TEMPLATE_CATEGORIES.map((category) => {
        const entries = matches.filter((template) => template.category === category);
        if (entries.length === 0) return null;
        return (
          <section key={category} className="mb-5" aria-label={category}>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{category}</h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {entries.map((template) => (
                <Card key={template.id} template={template} onPick={() => pick(template)} />
              ))}
            </div>
          </section>
        );
      })}
    </Dialog>
  );
}
