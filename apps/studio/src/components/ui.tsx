import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const BUTTON_TONES = {
  primary: "bg-accent text-white shadow-sm hover:bg-accent-strong",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-subtle",
  ghost: "text-ink-soft hover:bg-subtle hover:text-ink",
  danger: "bg-danger text-white hover:bg-danger/90",
  dark: "bg-ink text-canvas hover:bg-ink/85",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: keyof typeof BUTTON_TONES;
  size?: "sm" | "md";
  icon?: ReactNode;
}

export function Button({ tone = "secondary", size = "md", icon, className, children, type, ...rest }: ButtonProps): ReactNode {
  return (
    <button
      type={type ?? "button"}
      {...rest}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8.5 px-3 text-sm",
        BUTTON_TONES[tone],
        FOCUS,
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  active,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cx(
        "grid size-8 shrink-0 place-items-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-35",
        active ? "bg-accent-soft text-accent-ink" : "text-ink-soft hover:bg-subtle hover:text-ink",
        FOCUS,
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  options: Array<{ value: T; label: string; icon?: ReactNode }>;
  onChange: (value: T) => void;
  label: string;
}): ReactNode {
  return (
    <div role="tablist" aria-label={props.label} className="inline-flex gap-0.5 rounded-lg bg-subtle p-0.5">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === props.value}
          onClick={() => props.onChange(option.value)}
          className={cx(
            "inline-flex h-7.5 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-all",
            option.value === props.value ? "bg-surface text-ink shadow-sm" : "text-ink-soft hover:text-ink",
            FOCUS,
          )}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

const TONES = {
  neutral: "bg-subtle text-ink-soft",
  accent: "bg-accent-soft text-accent-ink",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
} as const;

export function Badge({ tone = "neutral", children, title }: { tone?: keyof typeof TONES; children: ReactNode; title?: string }): ReactNode {
  return (
    <span title={title} className={cx("inline-flex h-5 items-center rounded-md px-1.5 text-[11px] font-medium", TONES[tone])}>
      {children}
    </span>
  );
}

export const INPUT =
  "h-8.5 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-ink placeholder:text-ink-faint transition-shadow focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 disabled:bg-subtle disabled:text-ink-faint";

export function Field(props: { label: string; hint?: string; children: ReactNode; htmlFor?: string }): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.htmlFor} className="text-xs font-medium text-ink-soft">
        {props.label}
      </label>
      {props.children}
      {props.hint && <p className="text-[11px] leading-snug text-ink-faint">{props.hint}</p>}
    </div>
  );
}

/** A text input that commits on blur or Enter, so every keystroke is not a transaction. */
export function CommitInput(props: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  label: string;
  id?: string;
  multiline?: boolean;
  mono?: boolean;
  className?: string;
}): ReactNode {
  const [draft, setDraft] = useState(props.value);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setDraft(props.value);
  }, [props.value]);
  const commit = (): void => {
    if (!dirty.current) return;
    dirty.current = false;
    if (draft !== props.value) props.onCommit(draft);
  };
  const shared = {
    id: props.id,
    value: draft,
    placeholder: props.placeholder,
    "aria-label": props.label,
    onBlur: commit,
    className: cx(INPUT, props.mono && "font-mono text-xs", props.multiline && "h-auto py-2 leading-relaxed", props.className),
  };
  return props.multiline ? (
    <textarea
      {...shared}
      rows={Math.min(8, Math.max(2, draft.split("\n").length))}
      onChange={(event) => {
        dirty.current = true;
        setDraft(event.target.value);
      }}
    />
  ) : (
    <input
      {...shared}
      type="text"
      onChange={(event) => {
        dirty.current = true;
        setDraft(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") {
          dirty.current = false;
          setDraft(props.value);
        }
      }}
    />
  );
}

export function Toggle(props: { checked: boolean; onChange: (checked: boolean) => void; label: string }): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      onClick={() => props.onChange(!props.checked)}
      className={cx("relative h-5 w-9 shrink-0 rounded-full transition-colors", props.checked ? "bg-accent" : "bg-line-strong", FOCUS)}
    >
      <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-all", props.checked ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

export function Dialog(props: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  testId?: string;
}): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return (
    <div className="fixed inset-0 z-50 grid animate-fade place-items-center bg-black/30 p-6 backdrop-blur-[2px]" onMouseDown={props.onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        data-testid={props.testId}
        onMouseDown={(event) => event.stopPropagation()}
        className={cx("flex max-h-[85vh] w-full animate-rise flex-col rounded-2xl border border-line bg-surface shadow-pop", props.width ?? "max-w-md")}
      >
        <header className="flex items-start justify-between gap-4 px-6 pt-5">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-ink">{props.title}</h2>
            {props.description && <div className="mt-1 text-sm leading-relaxed text-ink-soft">{props.description}</div>}
          </div>
          <IconButton label="Close" onClick={props.onClose} className="-mr-2 -mt-1">
            <X className="size-4" />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{props.children}</div>
        {props.footer && <footer className="flex items-center justify-end gap-2 border-t border-line px-6 py-4">{props.footer}</footer>}
      </div>
    </div>
  );
}

/** A small menu anchored to its trigger; closes on outside click or Escape, and never opens off screen. */
export function Menu(props: { trigger: (toggle: () => void, open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right" }): ReactNode {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    const gutter = 8;
    if (rect.left < gutter) setShift(gutter - rect.left);
    else if (rect.right > window.innerWidth - gutter) setShift(window.innerWidth - gutter - rect.right);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      {props.trigger(() => setOpen((value) => !value), open)}
      {open && (
        <div
          ref={panel}
          role="menu"
          style={shift ? { translate: `${shift}px 0` } : undefined}
          className={cx(
            "absolute top-full z-40 mt-1.5 min-w-52 animate-rise rounded-xl border border-line bg-surface p-1 shadow-pop",
            props.align === "right" ? "right-0" : "left-0",
          )}
        >
          {props.children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem(props: { onSelect: () => void; children: ReactNode; icon?: ReactNode; tone?: "danger"; hint?: string }): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={props.onSelect}
      className={cx(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
        props.tone === "danger" ? "text-danger hover:bg-danger-soft" : "text-ink hover:bg-subtle",
      )}
    >
      {props.icon && <span className="grid size-4 shrink-0 place-items-center opacity-70">{props.icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{props.children}</span>
        {props.hint && <span className="block truncate text-xs text-ink-faint">{props.hint}</span>}
      </span>
    </button>
  );
}

export function EmptyState(props: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-16 text-center">
      {props.icon && <div className="grid size-11 place-items-center rounded-2xl bg-subtle text-ink-soft">{props.icon}</div>}
      <h3 className="text-base font-semibold tracking-tight text-ink">{props.title}</h3>
      {props.children && <p className="text-sm leading-relaxed text-ink-soft">{props.children}</p>}
      {props.action}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <div className="flex items-center justify-between">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{children}</h3>
      {action}
    </div>
  );
}
