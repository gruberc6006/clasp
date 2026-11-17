import { describeNetworkResource } from "@clasp/network";
import { CAPABILITY_LABELS, type Grant } from "@clasp/permissions";
import type { AppHandle, RequirementStatus } from "@clasp/runtime";
import { declaredResources } from "@clasp/runtime";
import { Globe, KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import type { ReactNode } from "react";
import { useStudio, useWorkspace } from "../studio/hooks";
import { describeRequest } from "./Overlays";
import { Badge, Button, EmptyState, SectionTitle } from "./ui";

function GrantRow({ grant, perspective }: { grant: Grant; perspective: "subject" | "resource" }): ReactNode {
  const workspace = useWorkspace();
  const studio = useStudio();
  const host = describeNetworkResource(grant.resource);
  const resource = workspace.kernel.getResource(grant.resource);
  const subject = workspace.kernel.principalName(grant.subject);
  const resourceName = host?.host ?? resource?.name ?? grant.resource;
  const owner = resource ? workspace.kernel.principalName(resource.ownerId) : "";
  const open = host ? (studio.network?.connections(grant.subject) ?? []).filter((connection) => connection.origin === host.origin).length : 0;
  return (
    <li className="flex items-center gap-3 px-3.5 py-2.5" data-testid="grant-row" data-subject={subject} data-resource={resourceName}>
      {host ? <Globe className="size-4 shrink-0 text-accent" /> : <KeyRound className="size-4 shrink-0 text-accent" />}
      <div className="min-w-0 flex-1 text-sm">
        <div className="truncate text-ink">
          {host ? (
            <>
              <span className="font-medium">Connect to {host.host}</span>
              <span className="text-ink-soft">
                {host.local ? " · this computer" : ""}
                {host.secure ? "" : " · not encrypted"}
              </span>
            </>
          ) : perspective === "subject" ? (
            <>
              <span className="font-medium">{CAPABILITY_LABELS[grant.capability]}</span> of <span className="font-medium">“{resourceName}”</span>
              {owner && owner !== resourceName && <span className="text-ink-soft"> · {owner}</span>}
            </>
          ) : (
            <>
              <span className="font-medium">{subject}</span> may: {CAPABILITY_LABELS[grant.capability].toLowerCase()} of “{resourceName}”
            </>
          )}
          {grant.actions && <span className="text-ink-soft"> ({grant.actions.join(", ")})</span>}
        </div>
        <div className="truncate text-xs text-ink-faint">
          <code>{host ? host.origin : grant.capability}</code> · granted {new Date(grant.grantedAt).toLocaleString()}
          {open > 0 && <span className="font-medium text-success"> · {open === 1 ? "1 open connection" : `${open} open connections`}</span>}
        </div>
      </div>
      <Button
        size="sm"
        onClick={() => {
          workspace.kernel.permissions.revoke(grant.id);
          studio.toast({ tone: "info", message: host ? `${subject} can no longer connect to ${host.host}.` : `${subject} can no longer access “${resourceName}”.` });
        }}
        data-testid="revoke-grant"
      >
        Revoke
      </Button>
    </li>
  );
}

function RequirementRow({ app, requirement }: { app: AppHandle; requirement: RequirementStatus }): ReactNode {
  const workspace = useWorkspace();
  const resource = workspace.kernel.getResource(requirement.resource);
  const object = app.store.graph.objects[requirement.objectId];
  return (
    <li className="flex items-center gap-3 px-3.5 py-2.5" data-testid="requirement-row">
      <ShieldOff className="size-4 shrink-0 text-ink-faint" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="truncate text-ink">
          Wants to: <span className="font-medium">{CAPABILITY_LABELS[requirement.capability].toLowerCase()}</span> of{" "}
          <span className="font-medium">“{resource?.name ?? "something not in this workspace"}”</span>
        </div>
        <div className="truncate text-xs text-ink-faint">
          needed by {object?.metadata.name ?? "an object"} · {requirement.reason}
        </div>
      </div>
      {requirement.resolved ? (
        <Button
          size="sm"
          tone="primary"
          data-testid="grant-requirement"
          onClick={() =>
            workspace.kernel.permissions.grant({
              subject: app.id,
              resource: requirement.resource,
              capability: requirement.capability,
              ...(requirement.actions ? { actions: requirement.actions } : {}),
            })
          }
        >
          Grant
        </Button>
      ) : (
        <Badge tone="warning">not available here</Badge>
      )}
    </li>
  );
}

function AppCard({ app }: { app: AppHandle }): ReactNode {
  const workspace = useWorkspace();
  const permissions = workspace.kernel.permissions;
  const held = permissions.list({ subject: app.id });
  const missing = workspace.requirements(app.id).filter((requirement) => !requirement.satisfied);
  const owned = declaredResources(app.store.graph, workspace.registry);
  const shared = owned.flatMap((resource) => permissions.list({ resource: resource.id }));
  const collections = owned.filter((resource) => resource.kind === "collection");
  return (
    <section className="rounded-2xl border border-line bg-surface" data-testid="permission-card" data-app={app.store.graph.metadata.name}>
      <header className="flex items-center gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold tracking-tight text-ink">{app.store.graph.metadata.name}</h3>
          <p className="truncate text-xs text-ink-soft">
            {collections.length > 0
              ? `Owns ${collections.map((collection) => `“${collection.name}”`).join(", ")}`
              : "Owns no data of its own"}
          </p>
        </div>
        <Badge tone={held.length > 0 ? "accent" : "neutral"}>{held.length === 1 ? "1 grant" : `${held.length} grants`}</Badge>
      </header>
      <div className="flex flex-col gap-4 p-5">
        <div>
          <SectionTitle>Can access</SectionTitle>
          {held.length === 0 ? (
            <p className="mt-2 text-sm text-ink-faint" data-testid="no-grants">
              Nothing outside itself.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
              {held.map((grant) => (
                <GrantRow key={grant.id} grant={grant} perspective="subject" />
              ))}
            </ul>
          )}
        </div>
        {missing.length > 0 && (
          <div>
            <SectionTitle>Not granted</SectionTitle>
            <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
              {missing.map((requirement) => (
                <RequirementRow key={`${requirement.objectId}:${requirement.capability}:${requirement.resource}`} app={app} requirement={requirement} />
              ))}
            </ul>
          </div>
        )}
        {shared.length > 0 && (
          <div>
            <SectionTitle>Shares with</SectionTitle>
            <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
              {shared.map((grant) => (
                <GrantRow key={grant.id} grant={grant} perspective="resource" />
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

/** Shows exactly which application may do what to which resource, and lets the user take it back. */
export function PermissionManager(): ReactNode {
  const workspace = useWorkspace();
  const apps = workspace.apps();
  const pending = workspace.kernel.permissions.pendingRequests();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="permission-manager">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-8">
        <header>
          <h2 className="text-xl font-semibold tracking-tight text-ink">Permissions</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">
            An application can always use what it owns. Everything else needs a grant from you — for one resource and one kind of access — and you can revoke it at
            any time. Revoking takes effect immediately.
          </p>
        </header>
        {pending.length > 0 && (
          <section className="rounded-2xl border border-accent/30 bg-accent-soft/60 p-5">
            <SectionTitle>Waiting for your answer</SectionTitle>
            <ul className="mt-3 flex flex-col gap-2">
              {pending.map((request) => (
                <li key={request.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-ink">{workspace.kernel.principalName(request.subject)}</span> asks to{" "}
                    {describeNetworkResource(request.resource)
                      ? describeRequest(request).join(", ").toLowerCase()
                      : `${describeRequest(request).join(", ").toLowerCase()} of “${workspace.kernel.getResource(request.resource)?.name ?? request.resource}”`}
                  </div>
                  <Button size="sm" onClick={() => workspace.kernel.permissions.resolveRequest(request.id, false)}>
                    Deny
                  </Button>
                  <Button size="sm" tone="primary" onClick={() => workspace.kernel.permissions.resolveRequest(request.id, true)}>
                    Allow
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {apps.length === 0 ? (
          <EmptyState icon={<ShieldCheck className="size-5" />} title="No applications">
            Permissions appear once applications exist.
          </EmptyState>
        ) : (
          apps.map((app) => <AppCard key={app.id} app={app} />)
        )}
      </div>
    </div>
  );
}
