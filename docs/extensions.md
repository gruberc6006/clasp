# Extensions

## What exists today: declarative extension packs

An extension pack (`clasp.extension`, manifest v1) is data only. It can
contribute:

- **schemas**, namespaced under the extension's own id (`acme.crm.*`); it can
  never redefine built-in or foreign schemas;
- **mappings** between schemas;
- **templates**, which are ordinary Clasp packages built from components the
  workspace already has.

`installExtension` validates everything first (format, namespace, conflicts
with registered schemas, every template's dependencies) and only then
registers anything, so a rejected extension changes nothing. Contributed
schemas are persisted with the workspace.

```ts
import { installExtension } from "@clasp/extensions";
const installed = installExtension(manifestJson, workspace);
// installed.templates[0].package → importPackage(...) → workspace.install(...)
```

## What does not exist: executable extensions

A manifest that tries to contribute code (`components`, `code`, `scripts`,
`main`, `entry`, `wasm`, `executable`) is rejected with `INVALID_OPERATION`.
This build has no isolation boundary that could contain third-party code, and
TypeScript types or a function wrapper are not one.

Before Clasp runs third-party code, the host must provide all of the following
(also exported as `SANDBOX_REQUIREMENTS`):

1. **A separate execution context** with its own global scope — a Worker inside
   a sandboxed, cross-origin iframe, or a WebAssembly runtime — with no access
   to the host's DOM, storage, cookies or JavaScript objects.
2. **No ambient authority**: no network, filesystem or other host API unless
   the user granted the matching capability to that extension.
3. **One channel**: a message-passing bridge to the Universal API, bound by the
   host to the extension's own principal and authorized by the kernel on every
   call — exactly like a built-in component's `ctx.clasp`.
4. **Data, not references**: only structured-clonable JSON crosses the
   boundary.
5. **Budgets**: enforced CPU and memory limits, with the host able to
   terminate a context that exceeds them.
6. **A declared manifest** of capabilities, approved by the user; anything not
   declared is denied.

A sandboxed component would then implement the same contract as a built-in
one — ports in, ports out, events, actions — with the runtime proxying
`ComponentContext` calls over the bridge. Nothing else in the platform would
need to change.
