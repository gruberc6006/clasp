import { ClaspError, isJsonObject, type JsonValue } from "@clasp/core";
import { SYSTEM_PRINCIPAL, type ClaspKernel } from "@clasp/universal-api";
import { FILE_STORE_ID, type FileEntry, type FileService } from "./service";

/** Resource id of the desktop service. */
export const DESKTOP_SERVICE_ID = "clasp.desktop";

/**
 * What the host does to open a file: pick (or create) an application that
 * edits that kind of document, give it the file, and bring it forward.
 * Returns the name of the application that opened it.
 */
export type FileLauncher = (file: FileEntry, callerId: string) => Promise<string>;

/**
 * The desktop service: lets an application (a file browser) ask the
 * desktop to open a workspace file in the application for its kind.
 *
 *   open {fileId}   → { openedIn }
 *
 * It is not user-mediated: the caller needs a grant of `capability.invoke`
 * on `clasp.desktop` (asked once), and must itself be allowed to list the
 * files (`collection.query` on the file store) — it can only open what the
 * user already lets it see.
 */
export class DesktopService {
  constructor(
    private readonly kernel: ClaspKernel,
    private readonly files: FileService,
    private launcher?: FileLauncher,
  ) {
    kernel.addResources(SYSTEM_PRINCIPAL, [
      {
        id: DESKTOP_SERVICE_ID,
        kind: "service",
        name: "Desktop",
        description: "Opens workspace files in the application that edits them.",
        ownerId: SYSTEM_PRINCIPAL,
        exposure: "discoverable",
        actions: [{ name: "open", description: "Opens a file in the application for its kind. Arguments: { fileId } (or a file row with id)." }],
      },
    ]);
    kernel.bindProvider(DESKTOP_SERVICE_ID, { invoke: (action, args, caller) => this.handle(action, args, caller) });
  }

  setLauncher(launcher: FileLauncher | undefined): void {
    this.launcher = launcher;
  }

  private async handle(action: string, args: JsonValue | undefined, caller: string): Promise<JsonValue> {
    if (action !== "open") throw new ClaspError("NOT_FOUND", `Desktop has no action "${action}".`);
    const input = isJsonObject(args) ? args : {};
    const fileId = typeof input.fileId === "string" ? input.fileId : typeof input.id === "string" ? input.id : undefined;
    if (!fileId) throw new ClaspError("VALIDATION_FAILED", "open needs { fileId }.");
    // Only files the caller may already see.
    this.kernel.permissions.authorize({ subject: caller, capability: "collection.query", resource: FILE_STORE_ID });
    const file = this.files.list().find((entry) => entry.id === fileId);
    if (!file) throw new ClaspError("NOT_FOUND", "That file no longer exists.");
    if (!this.launcher) throw new ClaspError("UNAVAILABLE", "This host cannot open files in applications.");
    return { openedIn: await this.launcher(file, caller) };
  }
}
