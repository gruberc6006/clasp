# Clasp architecture

Clasp is a local-first platform in which every application is a persistent
graph of deterministic components. Applications never share code or storage;
they meet only at one controlled boundary, the Universal API, where every call
is validated and authorized.

```
            ┌──────────────────────── apps/studio (React) ────────────────────────┐
            │  Use mode ─ renderer-react ─┐     Build mode ─ graph canvas/inspector │
            │                              │                  │                    │
            │          AI panel ─ @clasp/ai (proposes) ───────┤ (approved ops)     │
            └──────────────────────────────┼──────────────────┼────────────────────┘
                                           ▼                  ▼
   ┌──────────── @clasp/runtime: Workspace ─────────────────────────────────────────┐
   │  per application:  GraphStore (definition)  ──►  GraphRuntime (execution)        │
   │                       │ ops / undo / events          │ components get ctx.clasp │
   │                       ▼                              ▼                          │
   │              @clasp/universal-api ClaspKernel  ◄── one ClaspAPI handle per app  │
   │                 resource registry · DataStore · PermissionManager · schemas     │
   └───────────────────────────────┬──────────────────────────────────────────────┘
                                   ▼
                    @clasp/persistence  WorkspaceStorage → IndexedDB / memory
```

## Packages

| Package | Responsibility | Depends on |
| --- | --- | --- |
| `core` | Object model, graph operations, transactions, undo/redo, validation, serialization, dependency analysis | zod |
| `schemas` | Record schemas: validation, versions, extension, compatibility, explicit mappings | core |
| `permissions` | Resource-scoped capability grants, access requests, revocation | core |
| `persistence` | `StorageAdapter` interface, memory and IndexedDB adapters, typed workspace storage, revisions | core |
| `universal-api` | The kernel: resource registry, record store, `discover/query/mutate/subscribe/invoke` | core, schemas, permissions |
| `runtime` | Component contract and registry, deterministic graph runtime, the `Workspace` host | all of the above |
| `primitives` | Built-in interface, data, logic and composition components | core, runtime, universal-api |
| `workflows` | Workflow components and the notification service | core, runtime, universal-api |
| `renderer-react` | Draws running applications; reports gestures back to the runtime | core, runtime, React |
| `features` | Feature vocabulary and the deterministic feature compiler | core, runtime, schemas |
| `files` | User-mediated file service, `data.document`, the `document` feature | core, features, runtime, schemas, universal-api |
| `network` | Network service (WebSockets to hosts the user allows), `net.socket` | core, permissions, runtime, universal-api |
| `ai` | Provider interface, Ollama provider, scripted test provider, feature planning, validation and repair | core, features, runtime, schemas |
| `sharing` | Portable package format: export, validate, import, fork | core, runtime, schemas |
| `extensions` | Declarative extension packs; sandbox requirements for executable ones | core, runtime, schemas, sharing |
| `examples` | The 23 templates (tools, games, the two-application demonstration), built only from registered components, many from features | primitives, workflows, files, network, features |
| `apps/studio` | The Studio application | everything |

There are no circular dependencies. `core` and `runtime` know nothing about
React; `renderer-react` knows nothing about storage or AI.

## The object model (`@clasp/core`)

A `ClaspGraph` is the definition of one application and nothing else:

- `objects`: `ClaspObject { id, type, typeVersion, version, properties, parentId?, order, metadata }`.
  `properties` is configuration only. `parentId` expresses nesting.
- `connections`: `{ id, kind, source: {objectId, port}, target: {objectId, port} }`.
  `value` connections carry data from an output to an input; `event` connections make an event trigger an action.
- `interface`: the application's public face — exposed actions, events, outputs, inputs and views, each bound to one internal port or object.
- `version`: a revision counter bumped by every committed transaction.

Deliberately **not** in the graph, each in its own layer:

| Concern | Lives in |
| --- | --- |
| Runtime state (port values, component memory) | `GraphRuntime`, never persisted |
| Application data (records) | the kernel's `DataStore`, persisted in the `records` store |
| Presentation state (canvas positions) | `presentation` store |
| Permissions | `PermissionManager`, persisted in the `grants` store |
| History | `GraphStore` undo stack (session) and the `revisions` store (durable) |

### Changing a graph

Every change — from the canvas, the inspector, the AI or an import — is a list
of `GraphOperation`s (`create`, `update`, `delete`, `connect`, `disconnect`,
`setInterface`, `setMetadata`). `applyOperations` applies them to a copy and
then validates the *whole* result: referential integrity, containment (no
cycles, only containers have children), port existence, value-type
compatibility, value/event kind matching, one writer per input, no
value-dependency cycles, and a valid interface. Either everything applies or a
`VALIDATION_FAILED` error with one issue per problem is thrown and nothing
changes. `GraphStore` wraps this with undo/redo (immutable snapshots) and
change events.

## Components (`@clasp/runtime`, `@clasp/primitives`, `@clasp/workflows`)

A `ComponentDefinition` is a machine-readable description plus a deterministic
implementation: type, version, category, title, description, property specs
(the configuration schema), input/output ports, events, actions, required
capabilities, and `create(ctx)`. Optional hooks describe dynamic ports
(`app.embed`), resources the object declares (`data.collection`) and
resource-scoped capability requirements (`data.reference`, `logic.action`,
`workflow.notify`).

Besides the basics there are document editors (`ui.spreadsheet`,
`ui.canvas`, `ui.sequencer`, `ui.richText`, `ui.codeEditor`), tools
(`ui.calculator`, `ui.terminal`, `ui.clock`, `ui.board`, `ui.systemMonitor`)
and games (`game.ticTacToe`, `game.pairs`, `game.wordGuess`,
`game.glowworm`). They follow the same rules: state and rules in the
component, drawing in the renderer. The calculator and the terminal's `calc`
use the spreadsheet's formula interpreter, never `eval`; the word processor
parses Markdown into a plain block tree that the renderer draws, so a document
can never inject HTML or a `javascript:` link. Games use a seeded random
generator (`seed` property) so tests can replay them, and emit `finished` with
a `clasp.score` record. `workflow.invoke` runs one action of another resource,
asking the user for exactly that action the first time.

`ComponentRegistry` is the single catalog: the graph engine validates against
it, the runtime instantiates from it, the Studio's library lists it, and the AI
is shown `registry.catalog()` (pure JSON). Graphs can configure and connect
components; they can never supply code.

## Runtime lifecycle (`GraphRuntime`)

1. `start()` validates the graph, reports problems as diagnostics, refuses to
   run a value-dependency cycle, instantiates every object in topological
   order, delivers initial values, then calls each instance's `start()`.
2. All work — value propagation, event delivery, action handling, user
   gestures — goes through one FIFO scheduler, so execution order is
   reproducible. Unchanged values never propagate.
3. Limits stop runaway graphs: `maxStepsPerFlush` catches synchronous loops,
   `maxStepsPerSecond` catches loops that bounce through async work. Exceeding
   either halts the application with an `EXECUTION_LIMIT_EXCEEDED` diagnostic.
4. A failing component is contained: its error becomes a diagnostic on that
   object; the rest of the graph keeps running.
5. Graph edits while running are reconciled: changed objects are rebuilt
   (keeping their per-object state), removed objects are disposed, rewired
   inputs are re-delivered. Use mode and Build mode therefore share one running
   application, and undo/redo is reflected immediately.
6. `stop()` disposes every instance, timer and subscription.

Interfaces are optional: a headless workflow (e.g. Task Notifier) runs on
exactly the same runtime as a visual application.

## The Universal API (`@clasp/universal-api`)

Each application receives a `ClaspAPI` handle bound to its identity by the
host; it cannot choose who it is.

| Call | Does | Capability checked |
| --- | --- | --- |
| `discover(query)` | Lists resources the caller may know about (owned, discoverable, or granted), with ownership and current access | visibility only |
| `query({source, filter, sort, limit, offset, as})` | Reads records of a collection (optionally *as* another schema via compatibility or an explicit mapping), or current exposed outputs of an application | `collection.query` / `object.read` |
| `mutate({source, operation, ...})` | `create`, `update`, `delete`, atomic `batch` with optimistic `expectedVersion`; `set` for exposed inputs | `collection.mutate` / `object.write` |
| `subscribe({source, event, handler, onError})` | Record changes, exposed events, exposed output changes, or the caller's own `access` changes | `collection.query` / `object.read`, re-checked at **every delivery** |
| `invoke({target, action, arguments})` | Runs an exposed action | `capability.invoke` (optionally restricted to named actions) |
| `requestAccess({resource, capabilities, reason})` | Asks the user; resolves with their decision; grants nothing by itself | visibility only |

Errors are `ClaspError`s with a stable `code` (`VALIDATION_FAILED`,
`NOT_FOUND`, `PERMISSION_DENIED`, `CONFLICT`, `INCOMPATIBLE`, `UNAVAILABLE`,
`STORAGE_FAILURE`, …) and, for validation, one issue per problem. Results are
deep copies, so callers cannot corrupt the store.

Resources are: **collections** (declared by `data.collection` objects, owned by
their application), **applications** (their declared interface), and
**services** (e.g. `clasp.notifications`, owned by the system). An application
reaches another application's collection only through a grant on that
collection; access to an application is never access to its collections.

## Permissions (`@clasp/permissions`)

- An owner may do anything with its own resources.
- Everyone else needs a grant naming one subject, one resource and one
  capability. There are no wildcard grants.
- Grants come from the user (the permission prompt, or the Permissions view).
  `requestAccess` only records a request.
- Revocation is immediate: the kernel re-checks on every call and every event
  delivery, and terminates subscriptions whose access is gone (calling their
  `onError`).
- Removing an application revokes everything it held and everything granted on
  its resources. An imported or forked application has a new identity, so it
  inherits nothing.

Generated graphs are untrusted input: they are validated before they are
stored or run, and only registered components execute. There is no `eval`,
`new Function` or dynamic import anywhere in the platform.

## Storage (`@clasp/persistence`)

`StorageAdapter` is a small transactional key-value interface (`get`, `list`
by prefix, atomic `commit`). `IndexedDbStorage` implements it with one
database per workspace and one object store per concern (`graphs`,
`revisions`, `records`, `grants`, `presentation`, `schemas`, `meta`), and makes
each commit a single IndexedDB transaction. `WorkspaceStorage` adds typed
operations on top. Definitions and records are stored separately: replacing or
deleting an application definition never touches its records unless the user
explicitly asks for them to be erased.

A SQLite adapter would implement the same five methods; none is included yet.

## Features (`@clasp/features`)

People — and models — describe applications by what they do, not how they are
wired. A `FeaturePlan` names **entities** (kinds of records, with typed
fields) and **features** (`add`, `list`, `search`, `filter`, `sort`, `count`,
`share`, `calendar`, `board`, `tool`, `title`, `document`; `tool` places a ready-made instrument — calculator, clock, stopwatch, timer, terminal, system monitor, or a game with its high-score list). `compileFeatures` turns that into ordinary graph
operations, deterministically:

- **Entities → schemas.** Built-in entities (Task, Note, Contact, …) use the
  shared schemas; extra fields go into an extension schema (`user.task`
  extends `clasp.task`) so other applications can still read the records.
  Other entities get a `user.<name>` schema, versioned when fields are added.
- **Reuse, not duplication.** On an existing application the compiler finds
  the entity's collection, window, form and list by analysing the graph, and
  extends them: a `search` feature is inserted into the list's existing
  processing chain, an `add` feature adds missing inputs to the existing form.
  Data is never deleted.
- **Placement.** Visible elements go into the window in a sensible order
  (forms on top, controls above the list, counts below).
- **Errors in feature terms.** "Task has no field 'colour'… Its fields are: …".

`describeFeatures` does the reverse: it summarizes an application as
entities and features, which is what the model is shown when asked for a change.
Other packages add feature kinds through `FeatureExtension` (the `document`
feature lives in `@clasp/files`).

**Editing by features** (`edit.ts`). `inventory(graph, schemas)` reads an
application back as the records it keeps and the features it has. Each
feature carries its parameters as a `FeatureSpec` and the exact objects that
make it up. It recognizes applications built by hand as well as compiled
ones, and reports any objects it cannot account for. `removeFeature`
deletes a feature's objects and repairs what flowed through it: a removed
search is spliced out of the chain between the records and the list. A
removed list hands its search and sorts to the next list, or takes them along
if it was the last one. Records, and the collections that keep them, are
never removed; a window's title is changed, not removed. `changeFeature`
removes a feature and compiles it again from new parameters, as one
transaction. The Studio's Features panel uses these and shows the compiled
result ("This will: …") before anything changes.

## Files (`@clasp/files`)

Files live in a collection owned by the system, which no application can
query. Applications reach files only through the `clasp.files` service, using
the *powerbox* pattern of sandboxed desktop systems:

| Action | What happens | Consent |
| --- | --- | --- |
| `open {kind}` | The host shows an Open dialog; the file the user picks is returned | The dialog |
| `saveAs {kind, name, content}` | The host shows a Save As dialog; a file is created or replaced | The dialog |
| `save {fileId, content}` | Writes a file this application was given | The file's access list |
| `read {fileId}` | Reads a file this application was given | The file's access list |
| `recent {kind, slot}` | The file this application last used for `slot` | The file's access list |

`open` and `saveAs` are *user-mediated actions*: the kernel lets any
application call them without a grant because the service obtains consent
itself, in the dialog. Each file records which applications the user gave it
to; the Files section of the Studio shows and revokes that. The host supplies
the dialogs (`FileDialogs`), so the service works the same in the Studio and
in tests.

`data.document` connects an editor to the service: the editor's `value` flows
into `content`, `loaded` hands the editor a document, `title` is the file name
(marked when there are unsaved edits), and New / Open / Save / Save As are its
actions. The `document` feature wires an editor (`ui.textInput`,
`ui.spreadsheet`, `ui.canvas`, `ui.sequencer`), a document and a toolbar into a
window, and puts the file name in the title bar.

The editors hold their documents as plain JSON. Spreadsheet formulas are
parsed and evaluated by a small interpreter in `@clasp/primitives`
(`formula.ts`), never by `eval`. Drawing and sound are presentation, done by
the renderer: the canvas paints strokes from the document, and the sequencer
synthesizes its voices with Web Audio while the component holds the pattern
and the playing state.

## Network (`@clasp/network`)

Applications reach the network only through the `clasp.network` service.
They never hold a socket: the host (the Studio) gives the service a
`SocketFactory` backed by the browser's `WebSocket`, and the service keeps
every connection.

| Action | What happens |
| --- | --- |
| `connect {url, reason?}` | Validates the address (`ws://` or `wss://`, no user name or password). If the app has no grant for that origin, asks the user and waits. Opens the connection and returns `{socketId, url, host}`. |
| `send {socketId, text}` | Sends text on one of the caller's own connections. |
| `receive {socketId}` | Waits for messages and returns them: `{messages, state, reason?}`. |
| `close {socketId}` | Closes it. |

**Consent is per application and per origin.** A grant of `network.request`
on the resource id `network:<origin>` (for example
`network:wss://chat.example.org`) lets one application connect to that scheme,
host and port, and nothing else. The prompt names the host, says whether it is
this computer and whether the connection is encrypted. The service accepts
only an explicit grant, never ownership, and the kernel refuses to register
any resource whose id starts with `network:`, so no application can make a
host "its own". Grants are checked again on every `send`, `receive` and
incoming message, and revoking one closes that application's connections to
the host immediately. Socket ids belong to the application that opened them;
another application using one gets `NOT_FOUND`. Limits: four connections per
application, 64 KB text messages, 500 unread messages (older ones are
dropped).

`net.socket` is the component applications use. Its `connect`, `send`,
`disconnect` and `clear` actions call the service; incoming messages arrive
through a `receive` loop that runs as background work, so an application
waiting on a quiet server still counts as idle. It outputs a status, the
status in words, and the message log (newest first) for a list to show.

## More system services

- **`clasp.desktop`** (`@clasp/files`) opens a file in the application for its kind: an existing one, or a new one from the matching template; that application is given the file as if picked in a dialog, and its `data.document` loads it (`openFile`). The caller needs a grant for the `open` action *and* must already be allowed to list the file store, so it can open only what the user lets it see. The File Browser is the application that uses it.
- **`clasp.metrics`** (`@clasp/workflows`) exposes host measurements as outputs. Reading them needs `object.read`, granted by the user. The Studio's sampler measures only while someone reads: long tasks (Long Tasks API) as "main thread busy", timer lag, frames per second, JS heap where Chrome reports it, storage estimate, applications, records, connections and runtime steps per second. It does not, and cannot, report CPU usage.
- The file store (`clasp.files.store`) is discoverable, so a file browser can ask for it; listing it still needs the user's grant.

## The desktop (Studio)

Use mode is a desktop showing every application in the workspace. Each
top-level `ui.window` becomes a window with a title bar (its title input, so a
document's file name shows there), close / minimize / maximize controls,
dragging, resizing, focus stacking, and a window bar for minimized windows.
Window placement is presentation state, saved per workspace (in its `meta`
store), never part of a graph. The renderer draws only window contents when
the host supplies the chrome (`<AppView framed>`); embedded views still draw
their own card.

**Appearance** is presentation too, saved per workspace (`meta`): a theme
(automatic, light, dark), an accent and a desktop background (presets, or a
picture scaled down and kept as a data URL). The palette is CSS variables
(`renderer-react/theme.css`); a theme overrides them on `<html data-theme>`,
and an accent sets `--color-accent`, from which the stronger, softer and text
shades are mixed. Applications drawn by the renderer use the same variables,
so they follow the theme.

## AI construction (`@clasp/ai`)

1. The model is shown the feature vocabulary, the built-in entities, and the
   application being edited, described by its features (and, for advanced
   edits, by readable handles). It never sees ids, records or other
   applications.
2. It replies with a JSON plan: features and entities, plus optional raw
   operations for things features cannot express. With Ollama, the reply is
   constrained to the plan's JSON schema.
3. The feature compiler builds the graph changes; raw operations are resolved
   by handle. The combined result is simulated against the real graph and
   registry, and checked for run-time mistakes (form fields missing from the
   target schema, event payloads that do not fit their action). Every problem
   goes back to the model, in feature terms, for correction, up to a repair
   budget.
4. A valid result is a `Proposal`: its **target** (the application it was
   asked from, or a new one — from the plan's `"app"` field, falling back to
   a narrow reading of the request such as "make a … app"), a plain-language
   list of features, the graph operations, and any record schemas it
   defines. A new-application proposal is compiled against an empty graph;
   `retarget` recompiles the same plan for the other target without another
   model call. The user reviews it;
   `applyProposal` registers the schemas and commits the operations as one
   ordinary, undoable transaction.

`OllamaProvider` talks to any Ollama-compatible server. `ScriptedProvider`
replays predefined plans for the two demonstration requests; it is labelled
"not an AI" everywhere and exists for tests and model-less machines. If no
model is reachable, the Studio says so and everything else keeps working.

## Sharing (`@clasp/sharing`)

A package (`clasp.package`, format v1) contains the graph, required component
types and versions, schema dependencies (bundling non-built-in definitions),
the capabilities the application will ask for (informational), optional
layout and assets, and an integrity checksum. It never contains records or
grants. Import validates structure, checksum, format and API versions and
dependencies, then gives every object, connection and the application a fresh
identity; references to external resources are kept and must be granted anew.

## Composition

`app.embed` uses another application as a component: the target's exposed
outputs, events, actions and inputs become the embed's ports, and an exposed
view is rendered in place. Everything travels through the Universal API under
the embedding application's identity and needs the user's grant; nothing
undeclared is reachable.
