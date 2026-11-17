import type { CSSProperties } from "react";

/**
 * How the Studio looks: light or dark, an accent colour and the desktop
 * background. Saved with each workspace, so a work and a personal workspace
 * can look different.
 */

export type ThemeChoice = "system" | "light" | "dark";

export interface Appearance {
  theme: ThemeChoice;
  /** An accent id from ACCENTS. */
  accent: string;
  /** A background id from BACKGROUNDS, or "picture". */
  background: string;
  /** The user's own picture, as a data URL (only when background is "picture"). */
  picture?: string;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: "system", accent: "violet", background: "dots" };

export const THEMES: ReadonlyArray<{ id: ThemeChoice; label: string }> = [
  { id: "system", label: "Automatic" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export const ACCENTS: ReadonlyArray<{ id: string; label: string; color: string }> = [
  { id: "violet", label: "Violet", color: "#6c47ff" },
  { id: "blue", label: "Blue", color: "#2563eb" },
  { id: "teal", label: "Teal", color: "#0d9488" },
  { id: "green", label: "Green", color: "#15803d" },
  { id: "orange", label: "Orange", color: "#ea580c" },
  { id: "rose", label: "Rose", color: "#e11d48" },
  { id: "graphite", label: "Graphite", color: "#52525b" },
];

export interface BackgroundPreset {
  id: string;
  label: string;
  /** CSS for the desktop. `dots` uses the theme's own colours. */
  style: CSSProperties;
  /** True when windows sit on something dark, so the desktop's own text should be light. */
  dark?: boolean;
}

export const BACKGROUNDS: readonly BackgroundPreset[] = [
  {
    id: "dots",
    label: "Dots",
    style: {
      backgroundColor: "var(--color-canvas)",
      backgroundImage: "radial-gradient(var(--color-line-strong) 1px, transparent 1px)",
      backgroundSize: "22px 22px",
      backgroundPosition: "-11px -11px",
    },
  },
  { id: "plain", label: "Plain", style: { backgroundColor: "var(--color-canvas)" } },
  {
    id: "grid",
    label: "Paper",
    style: {
      backgroundColor: "var(--color-canvas)",
      backgroundImage: "linear-gradient(var(--color-line) 1px, transparent 1px), linear-gradient(90deg, var(--color-line) 1px, transparent 1px)",
      backgroundSize: "28px 28px",
    },
  },
  { id: "dawn", label: "Dawn", style: { backgroundImage: "linear-gradient(135deg, #ffd6a5 0%, #fdacbc 45%, #c5b4f5 100%)" } },
  { id: "meadow", label: "Meadow", style: { backgroundImage: "linear-gradient(160deg, #d4f5c9 0%, #9fd8b8 50%, #6fb7c9 100%)" } },
  { id: "ocean", label: "Ocean", style: { backgroundImage: "radial-gradient(circle at 20% 15%, #4fb4e8 0%, transparent 45%), linear-gradient(160deg, #0b4f8a 0%, #062a4d 100%)" }, dark: true },
  { id: "dusk", label: "Dusk", style: { backgroundImage: "radial-gradient(circle at 80% 10%, #f28f6b 0%, transparent 40%), linear-gradient(170deg, #4b2a6b 0%, #1d1433 100%)" }, dark: true },
  { id: "night", label: "Night", style: { backgroundImage: "radial-gradient(circle at 30% 20%, #2a2f4f 0%, #0d0e17 70%)" }, dark: true },
];

/** The largest picture accepted as a background, before it is resized. */
export const MAX_PICTURE_BYTES = 15 * 1024 * 1024;

export function normalizeAppearance(value: unknown): Appearance {
  const input = (value && typeof value === "object" ? value : {}) as Partial<Appearance>;
  const theme = THEMES.some((entry) => entry.id === input.theme) ? (input.theme as ThemeChoice) : DEFAULT_APPEARANCE.theme;
  const accent = ACCENTS.some((entry) => entry.id === input.accent) ? (input.accent as string) : DEFAULT_APPEARANCE.accent;
  const picture = typeof input.picture === "string" && input.picture.startsWith("data:image/") ? input.picture : undefined;
  const background =
    input.background === "picture" && picture ? "picture" : BACKGROUNDS.some((entry) => entry.id === input.background) ? (input.background as string) : DEFAULT_APPEARANCE.background;
  return { theme, accent, background, ...(picture ? { picture } : {}) };
}

/** Light or dark, after following the system setting. */
export function resolveTheme(theme: ThemeChoice, prefersDark: boolean): "light" | "dark" {
  return theme === "system" ? (prefersDark ? "dark" : "light") : theme;
}

/** The desktop's background style. */
export function desktopBackground(appearance: Appearance): { style: CSSProperties; dark: boolean } {
  if (appearance.background === "picture" && appearance.picture) {
    return {
      style: { backgroundImage: `url("${appearance.picture}")`, backgroundSize: "cover", backgroundPosition: "center", backgroundColor: "#111" },
      dark: true,
    };
  }
  const preset = BACKGROUNDS.find((entry) => entry.id === appearance.background) ?? (BACKGROUNDS[0] as BackgroundPreset);
  return { style: preset.style, dark: preset.dark === true };
}

/** Applies the theme and accent to the page. */
export function applyAppearance(appearance: Appearance, prefersDark: boolean): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(appearance.theme, prefersDark);
  const accent = ACCENTS.find((entry) => entry.id === appearance.accent);
  if (!accent || accent.id === DEFAULT_APPEARANCE.accent) {
    root.style.removeProperty("--color-accent");
    delete root.dataset.accent;
  } else {
    root.style.setProperty("--color-accent", accent.color);
    root.dataset.accent = accent.id;
  }
}

/**
 * Reads a picture the user chose, scaled down to at most 2560 pixels wide and
 * re-encoded as JPEG, so it stays small enough to keep with the workspace.
 */
export async function readPicture(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error(`“${file.name}” is not a picture.`);
  if (file.size > MAX_PICTURE_BYTES) throw new Error(`“${file.name}” is larger than 15 MB.`);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 2560 / Math.max(image.naturalWidth, 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot prepare the picture.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch (error) {
    throw new Error(error instanceof Error && error.message.startsWith("“") ? error.message : `Could not read “${file.name}” as a picture.`);
  } finally {
    URL.revokeObjectURL(url);
  }
}
