import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useStudio } from "../studio/hooks";
import { cx } from "./ui";

/**
 * Edits an application's name in place: Enter or clicking away saves,
 * Escape cancels. A name the session refuses (empty, taken) keeps the field
 * open so it can be corrected.
 */
export function RenameInput(props: { appId: string; name: string; className?: string }): ReactNode {
  const studio = useStudio();
  const [draft, setDraft] = useState(props.name);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const commit = (): void => {
    if (done.current) return;
    if (studio.renameApp(props.appId, draft)) {
      done.current = true;
      studio.endRename();
    } else {
      input.current?.focus();
    }
  };
  return (
    <input
      ref={input}
      value={draft}
      aria-label="Application name"
      data-testid="rename-input"
      maxLength={80}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          done.current = true;
          studio.endRename();
        }
      }}
      onBlur={() => {
        // Clicking away saves, unless that name was refused — then put it back as it was.
        if (done.current) return;
        if (!studio.renameApp(props.appId, draft)) setDraft(props.name);
        done.current = true;
        studio.endRename();
      }}
      className={cx(
        "min-w-0 rounded-md border border-accent bg-surface px-2 text-ink outline-none ring-2 ring-accent/25",
        props.className,
      )}
    />
  );
}
