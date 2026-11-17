import type { Workspace } from "@clasp/runtime";
import { createContext, useContext, useSyncExternalStore } from "react";
import type { StudioSession } from "./session";

export const StudioContext = createContext<StudioSession | null>(null);

/** The Studio session; the calling component re-renders whenever it changes. */
export function useStudio(): StudioSession {
  const session = useContext(StudioContext);
  if (!session) throw new Error("useStudio must be used inside the Studio.");
  useSyncExternalStore(session.subscribe, session.getVersion, session.getVersion);
  return session;
}

/** The open workspace. Only call from components rendered while the session is ready. */
export function useWorkspace(): Workspace {
  const session = useStudio();
  if (!session.workspace) throw new Error("No workspace is open.");
  return session.workspace;
}

/** Saves text as a file through the browser's download mechanism. */
export function downloadText(fileName: string, text: string, mimeType = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
