import { Check, ImagePlus, Monitor, Moon, Sun, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ACCENTS, BACKGROUNDS, THEMES, applyAppearance, desktopBackground, readPicture, type ThemeChoice } from "../studio/appearance";
import { useStudio } from "../studio/hooks";
import { Button, Dialog, cx } from "./ui";

/** Keeps the page's theme and accent in step with the workspace's appearance (and the system, for Automatic). */
export function AppearanceEffect(): null {
  const studio = useStudio();
  const { theme, accent } = studio.appearance;
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => applyAppearance(studio.appearance, query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [theme, accent]);
  return null;
}

const THEME_ICONS: Record<ThemeChoice, ReactNode> = {
  system: <Monitor className="size-4" />,
  light: <Sun className="size-4" />,
  dark: <Moon className="size-4" />,
};

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{title}</h3>
      {children}
    </section>
  );
}

/** Theme, accent colour and desktop background. */
export function AppearanceDialog(): ReactNode {
  const studio = useStudio();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (!studio.appearanceOpen) return null;
  const appearance = studio.appearance;
  return (
    <Dialog
      title="Appearance"
      description="How this workspace looks. It is saved with the workspace."
      onClose={() => studio.setAppearanceOpen(false)}
      width="max-w-xl"
      testId="appearance"
    >
      <Section title="Theme">
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={appearance.theme === theme.id}
              data-testid={`theme-${theme.id}`}
              onClick={() => studio.setAppearance({ theme: theme.id })}
              className={cx(
                "flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors",
                appearance.theme === theme.id ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-soft hover:bg-subtle hover:text-ink",
              )}
            >
              {THEME_ICONS[theme.id]}
              {theme.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Accent colour">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((accent) => (
            <button
              key={accent.id}
              type="button"
              role="radio"
              aria-checked={appearance.accent === accent.id}
              aria-label={accent.label}
              title={accent.label}
              data-testid={`accent-${accent.id}`}
              onClick={() => studio.setAppearance({ accent: accent.id })}
              className={cx("grid size-8 place-items-center rounded-full ring-offset-2 ring-offset-surface transition-transform hover:scale-110", appearance.accent === accent.id && "ring-2 ring-ink")}
              style={{ backgroundColor: accent.color }}
            >
              {appearance.accent === accent.id && <Check className="size-4 text-white" strokeWidth={3} />}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Desktop background">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Desktop background">
          {BACKGROUNDS.map((background) => (
            <button
              key={background.id}
              type="button"
              role="radio"
              aria-checked={appearance.background === background.id}
              data-testid={`background-${background.id}`}
              onClick={() => studio.setAppearance({ background: background.id })}
              className={cx("flex flex-col gap-1 rounded-xl p-1 text-left text-xs text-ink-soft", appearance.background === background.id ? "bg-accent-soft text-accent-ink" : "hover:bg-subtle")}
            >
              <span className={cx("block h-14 rounded-lg border", appearance.background === background.id ? "border-accent" : "border-line")} style={background.style} />
              <span className="px-1 font-medium">{background.label}</span>
            </button>
          ))}
          {appearance.picture && (
            <button
              type="button"
              role="radio"
              aria-checked={appearance.background === "picture"}
              data-testid="background-picture"
              onClick={() => studio.setAppearance({ background: "picture" })}
              className={cx("flex flex-col gap-1 rounded-xl p-1 text-left text-xs text-ink-soft", appearance.background === "picture" ? "bg-accent-soft text-accent-ink" : "hover:bg-subtle")}
            >
              <span className={cx("block h-14 rounded-lg border", appearance.background === "picture" ? "border-accent" : "border-line")} style={desktopBackground({ ...appearance, background: "picture" }).style} />
              <span className="px-1 font-medium">Your picture</span>
            </button>
          )}
        </div>
        <div className="mt-3 flex gap-2">
          <Button icon={<ImagePlus className="size-3.5" />} onClick={() => file.current?.click()} disabled={busy}>
            {busy ? "Preparing…" : "Use a picture…"}
          </Button>
          {appearance.picture && (
            <Button icon={<Trash2 className="size-3.5" />} onClick={() => studio.setAppearance({ picture: undefined, background: appearance.background === "picture" ? "dots" : appearance.background })}>
              Remove picture
            </Button>
          )}
        </div>
        <input
          ref={file}
          type="file"
          accept="image/*"
          className="hidden"
          data-testid="background-file"
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            event.target.value = "";
            if (!chosen) return;
            setBusy(true);
            readPicture(chosen)
              .then((picture) => studio.setAppearance({ picture, background: "picture" }))
              .catch((error: unknown) => studio.toast({ tone: "error", message: error instanceof Error ? error.message : String(error) }))
              .finally(() => setBusy(false));
          }}
        />
        <p className="mt-2 text-xs text-ink-faint">Pictures stay in this workspace on this computer. Large ones are scaled down.</p>
      </Section>
    </Dialog>
  );
}
