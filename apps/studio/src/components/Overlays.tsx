import { describeNetworkResource, type SocketAddress } from "@clasp/network";
import { CAPABILITY_LABELS, type AccessRequest } from "@clasp/permissions";
import { AlertCircle, CheckCircle2, Globe, Info, ShieldQuestion, TriangleAlert, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { useStudio } from "../studio/hooks";
import type { Toast } from "../studio/session";
import { Badge, Button, cx } from "./ui";

const TOAST_ICON: Record<Toast["tone"], ReactNode> = {
  info: <Info className="size-4 text-ink-soft" />,
  success: <CheckCircle2 className="size-4 text-success" />,
  warning: <TriangleAlert className="size-4 text-warning" />,
  error: <AlertCircle className="size-4 text-danger" />,
};

function ToastCard({ toast }: { toast: Toast }): ReactNode {
  const studio = useStudio();
  useEffect(() => {
    const timer = setTimeout(() => studio.dismissToast(toast.id), toast.tone === "error" ? 9000 : 5500);
    return () => clearTimeout(timer);
  }, [toast.id]);
  return (
    <div
      role={toast.tone === "error" ? "alert" : "status"}
      data-testid="toast"
      data-tone={toast.tone}
      className="pointer-events-auto flex w-80 animate-rise items-start gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 shadow-pop"
    >
      <span className="mt-0.5 shrink-0">{TOAST_ICON[toast.tone]}</span>
      <div className="min-w-0 flex-1 text-sm">
        {toast.title && <div className="font-medium text-ink">{toast.title}</div>}
        <div className={cx("break-words leading-snug", toast.title ? "text-ink-soft" : "text-ink")}>{toast.message}</div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => studio.dismissToast(toast.id)}
        className="-mr-1 grid size-6 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-subtle hover:text-ink"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function Toasts(): ReactNode {
  const studio = useStudio();
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex flex-col gap-2" aria-live="polite">
      {studio.toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

/** Human description of what an access request would allow. */
export function describeRequest(request: AccessRequest): string[] {
  const host = describeNetworkResource(request.resource);
  if (host) return [`Connect to ${host.host}`];
  return request.capabilities.map((capability) => {
    const label = CAPABILITY_LABELS[capability];
    return capability === "capability.invoke" && request.actions?.length ? `${label}: ${request.actions.join(", ")}` : label;
  });
}

/**
 * The permission prompt. An application can only *ask*; this is where the
 * user answers. Nothing is granted until "Allow" is pressed.
 */
export function PermissionPrompt(): ReactNode {
  const studio = useStudio();
  const workspace = studio.workspace;
  const request = workspace?.kernel.permissions.pendingRequests()[0];
  if (!workspace || !request) return null;
  const resource = workspace.kernel.getResource(request.resource);
  const subject = workspace.kernel.principalName(request.subject);
  const owner = resource ? workspace.kernel.principalName(resource.ownerId) : "unknown";
  const waiting = workspace.kernel.permissions.pendingRequests().length - 1;
  const answer = (approve: boolean): void => {
    workspace.kernel.permissions.resolveRequest(request.id, approve);
  };
  const host = describeNetworkResource(request.resource);
  if (host) return <NetworkPrompt request={request} subject={subject} host={host} waiting={waiting} answer={answer} />;
  return (
    <div className="fixed inset-0 z-50 grid animate-fade place-items-center bg-black/30 p-6 backdrop-blur-[2px]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Permission request"
        data-testid="permission-prompt"
        className="w-full max-w-md animate-rise rounded-2xl border border-line bg-surface shadow-pop"
      >
        <div className="flex flex-col gap-4 px-6 pb-5 pt-6">
          <div className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent-ink">
            <ShieldQuestion className="size-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold tracking-tight text-ink">
              Allow “{subject}” to access “{resource?.name ?? request.resource}”?
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-ink-soft">
              {resource?.kind === "collection" ? "This collection" : "This resource"} belongs to <span className="font-medium text-ink">{owner}</span>
              {resource?.schema ? (
                <>
                  {" "}
                  and holds <code className="rounded bg-subtle px-1 py-0.5 text-xs">{resource.schema.id}</code> records
                </>
              ) : null}
              . You can revoke this at any time under Permissions.
            </p>
          </div>
          <ul className="flex flex-col gap-1.5 rounded-xl border border-line bg-canvas/60 p-3">
            {describeRequest(request).map((line) => (
              <li key={line} className="flex items-center gap-2 text-sm text-ink">
                <CheckCircle2 className="size-4 shrink-0 text-accent" />
                {line}
              </li>
            ))}
          </ul>
          {request.reason && (
            <p className="text-sm text-ink-soft">
              <span className="font-medium text-ink">{subject}</span> says: “{request.reason}”
            </p>
          )}
        </div>
        <footer className="flex items-center justify-between gap-2 border-t border-line px-6 py-4">
          <span>{waiting > 0 && <Badge>{waiting} more waiting</Badge>}</span>
          <div className="flex gap-2">
            <Button onClick={() => answer(false)} data-testid="permission-deny">
              Don’t allow
            </Button>
            <Button tone="primary" onClick={() => answer(true)} data-testid="permission-allow">
              Allow
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** Asking to let one application connect to one host. */
function NetworkPrompt(props: { request: AccessRequest; subject: string; host: SocketAddress; waiting: number; answer: (approve: boolean) => void }): ReactNode {
  const { request, subject, host, waiting, answer } = props;
  return (
    <div className="fixed inset-0 z-50 grid animate-fade place-items-center bg-black/30 p-6 backdrop-blur-[2px]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Permission request"
        data-testid="permission-prompt"
        data-kind="network"
        className="w-full max-w-md animate-rise rounded-2xl border border-line bg-surface shadow-pop"
      >
        <div className="flex flex-col gap-4 px-6 pb-5 pt-6">
          <div className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent-ink">
            <Globe className="size-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold tracking-tight text-ink">
              Allow “{subject}” to connect to <span className="break-all">{host.host}</span>?
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-ink-soft">
              {host.local ? "This is a server on your own computer. " : ""}
              {subject} will be able to send data to this server and receive data from it — including anything you type into the app. Only allow servers you trust.
            </p>
          </div>
          <ul className="flex flex-col gap-1.5 rounded-xl border border-line bg-canvas/60 p-3 text-sm text-ink">
            <li className="flex items-center gap-2">
              <CheckCircle2 className="size-4 shrink-0 text-accent" />
              Only <code className="rounded bg-subtle px-1 py-0.5 text-xs">{host.origin}</code> — not other servers
            </li>
            <li className="flex items-center gap-2">
              {host.secure ? <CheckCircle2 className="size-4 shrink-0 text-accent" /> : <TriangleAlert className="size-4 shrink-0 text-warning" />}
              {host.secure ? "Encrypted (wss://)" : "Not encrypted (ws://): others on the network could read it"}
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 className="size-4 shrink-0 text-accent" />
              You can revoke this under Permissions; that closes the connection at once
            </li>
          </ul>
          {request.reason && (
            <p className="text-sm text-ink-soft">
              <span className="font-medium text-ink">{subject}</span> says: “{request.reason}”
            </p>
          )}
        </div>
        <footer className="flex items-center justify-between gap-2 border-t border-line px-6 py-4">
          <span>{waiting > 0 && <Badge>{waiting} more waiting</Badge>}</span>
          <div className="flex gap-2">
            <Button onClick={() => answer(false)} data-testid="permission-deny">
              Don’t allow
            </Button>
            <Button tone="primary" onClick={() => answer(true)} data-testid="permission-allow">
              Allow
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
