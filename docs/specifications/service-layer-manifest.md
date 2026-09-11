# Specification — Service Layer Manifest (static parity enforcement)

**Status:** Draft
**Depends on:** [`service-layer.md`](./service-layer.md) §2–§3 (the `src/lib/services/*.ts` module layout this doc assumes exists) — this is an addendum, not a replacement. Written as a **separate file on purpose**: the service layer is actively being implemented against that spec right now, and editing it mid-implementation would move the target the implementing agent is building against. This doc layers on top once (or as) that module layout lands.
**Motivated by:** a question about whether MCP/UI parity can be enforced statically rather than by convention — i.e. can the compiler catch "a new service method exists but nothing exposes it," the same way `switch`-exhaustiveness catches an unhandled enum member.

---

## 1. Problem

`service-layer.md` fixes _internal_ completeness: once a use case (e.g. `createDocument`) is implemented as a service function, that one implementation always does its full contract (permission check, mutation, audit, side effects) — because there's only one of it.

What it doesn't fix is _external_ completeness: nothing yet guarantees that every service function is actually wired up to the adapters it's supposed to be reachable from. That's the same class of problem as the `create_document` self-grant bug, one level up the stack — instead of "does this function do the right things," it's "does every function that should be callable via MCP have an MCP tool, and does every function the UI needs have a route/action calling it, and does that stay true as new service methods get added over time." Today that's tracked by convention (a checklist, a code review) — nothing breaks the build if `moveDocument` ships in `services/documents.ts` and nobody adds `move_document` to the MCP tool table.

## 2. Decision

Derive an exhaustive `ServiceMethod` union directly from the service modules — never hand-maintained, so it can't drift from the actual code — and require a `serviceSurfaces` manifest typed against that union. Adding a service method without updating the manifest is a compile error; adding a manifest entry without a real method is also a compile error (the union is the source of truth in both directions).

```ts
// src/lib/services/manifest.ts
import * as documents from './documents';
import * as records from './records';
import * as holds from './holds';
import * as collections from './collections';
import * as search from './search';

export const serviceModules = { documents, records, holds, collections, search } as const;

type ServiceModuleName = keyof typeof serviceModules;
type MethodOf<M extends ServiceModuleName> = keyof (typeof serviceModules)[M];

// e.g. "documents.createDocument" | "documents.moveDocument" | "records.writeRecord" | ...
export type ServiceMethod = {
	[M in ServiceModuleName]: `${M}.${MethodOf<M> & string}`;
}[ServiceModuleName];

export const serviceSurfaces: Record<ServiceMethod, { mcp: boolean; ui: boolean }> = {
	'documents.createDocument': { mcp: true, ui: true },
	'documents.moveDocument': { mcp: true, ui: false }, // sidebar drag-and-drop not built yet — tracked in phase-1-plan.md M2
	'documents.deleteDocument': { mcp: true, ui: true },
	'records.createRecord': { mcp: true, ui: true },
	'records.writeRecord': { mcp: true, ui: true }
	// ...one entry per method, or TypeScript won't compile.
};
```

`{ mcp: false, ui: false }` is a valid, explicit entry — some service methods may be internal helpers not meant to be directly exposed on either surface. The point isn't "everything must be on every surface," it's that the decision is **written down and machine-checked**, not silently absent.

## 3. Closing the runtime gap

The manifest guarantees every method has a recorded _intent_. It cannot, by itself, guarantee an MCP tool or route handler that claims to implement a method actually calls that function — that's a runtime relationship between two independently hand-written call sites, which is exactly the kind of drift that caused the `create_document` bug in the first place. Two complementary techniques close it, in order of preference:

1. **Generate the MCP tool table from the manifest, don't hand-write it.** For every `mcp: true` entry, a thin generic wrapper (`(input) => serviceModules[module][method](actor, input)`) registers the tool — there is no second hand-written call site to drift, because there's only one. Reserve hand-written MCP tool definitions for the rare method that needs genuinely custom input shaping beyond what the service function's own parameter type already describes.
2. **A wiring-check test for the UI side — implemented.** SvelteKit's file-based routing means routes/actions can't be generated the same way (each often has form-specific validation, redirects, or multi-step flows). A Tier A test (`17` in `tests/e2e/tier-a.test.ts`, see [`e2e-testing.md`](./e2e-testing.md) §2) walks `uiAdapterBindings`, and for every entry drives the real UI path through the test harness and asserts the declared service method's observable effect actually happened (the audit entry, or the persisted state a subsequent real read reflects) — the same "second, independent call observes the real effect" pattern already established for the MCP side, applied to the manifest as one parametrized test instead of N bespoke ones. Concretely, "the real UI path" is one of two shapes, both driven through `tests/e2e/harness.ts`:
   - For a route/action `uiAdapterBindings` binds to a `+server.ts` handler or a form action (most `documents.*`/`collections.*`/`spaces.*`/`tokens.*`/`audit.*` entries): a real HTTP request against the built app (`harness.hasAppHandler`/`build/handler.js` — see `e2e-testing.md` §3).
   - For a surface the UI reaches by mutating its own Yjs doc directly rather than calling the service function at all (`records.createRecord`/`writeRecord`/`deleteRecord`, `documents.updateDocumentTitle`, `collections.updateCollectionTitle` — this is `audit-coverage.md`'s whole premise, not a gap): the same data-layer call the bound `.svelte` file performs, over a real y-websocket client, asserting the audit-observer's (differently-named, e.g. `update_document` rather than `update_document_title`) equivalent event.

   Building this test surfaced real, pre-existing drift the static half of the manifest couldn't catch: `documents.getDocument`, `records.getRecord`, `collections.queryCollection`, `holds.holdRecords`, and `holds.releaseRecords` were declared `ui: true` with a `uiAdapterBindings` entry, but nothing in `src/routes` actually called them — the Document/Collection page loads use lightweight data-layer reads for just a title (the live content/rows come from the browser's own Yjs client, never a synchronous service call), and holds are an MCP/agent-only concept (`collaboration.md`) with no UI-side equivalent at all. All five are now correctly `ui: false`, with the reasoning recorded at each entry in `src/lib/services/manifest.ts` — this closes the exact gap [issue #213](https://github.com/brylie/compendium/issues/213) described (a `uiAdapterBindings` entry whose bound file doesn't actually call the bound method), by making the declaration honest rather than adding a check that would have had to permanently fail against it.

Static typing alone gets you "nothing was forgotten from the list." It cannot get you "the thing on the list is wired correctly" — that residual has to be a test, and the manifest is what makes that test parametrized and complete instead of another hand-maintained list. The implemented manifest also owns typed `mcpAdapterBindings` and `uiAdapterBindings`: tests prove both maps match the declared surfaces exactly (no missing adapter and no undeclared adapter).

## 4. What this fixes, concretely

- **Silent omission.** Today, shipping a new service method without an MCP tool or UI route compiles fine and looks done. With the manifest, it's a compile error until someone makes an explicit `{ mcp: false, ui: false }` (or `true`) decision — the gap becomes visible instead of implicit.
- **Recurrence of the self-grant bug's shape, elsewhere.** The original bug wasn't really about grants — it was "a call site claimed to do something it didn't." The manifest doesn't stop a call site from being wrong internally (that's §2's job in `service-layer.md`), but the generated-MCP-table half of §3 above removes the possibility of an MCP tool silently not calling its service function at all, which is the most severe version of that failure mode.
- **A checklist that can't go stale.** `phase-1-plan.md`'s "Follow-up from architecture review" note and `phase-2-plan.md`'s M1 checklist are both static documents that require someone to remember to update them. `serviceSurfaces` is the same information, but the compiler checks it on every build.

## 5. Migration plan

Additive, and sequenced strictly after `service-layer.md`'s M1 gives it something to point at — this is not a prerequisite for that work, don't block M1 on it:

1. Once `src/lib/services/documents.ts` exists (service-layer spec §5 step 1), add `src/lib/services/manifest.ts` covering just that module — `ServiceMethod` and `serviceSurfaces` don't need every aggregate populated on day one, only the ones that exist yet.
2. Regenerate the MCP tool registrations for `documents.*` from the manifest (§3.1) as part of the same work that points `create_document`'s handler at the new service function (service-layer spec §5 step 2) — this is the natural moment, since that handler is already being rewritten.
3. ~~Add the one parametrized UI wiring-check test (§3.2) to the Tier A suite once `tests/e2e/harness.ts` exists.~~ Done — see §3.2 above.
4. Extend `serviceModules` / `serviceSurfaces` to `records`, `holds`, `collections`, `search`, `spaces`, `tokens`, and audit history in step with the service migration — every exported use case has an explicit surface decision.

## 6. Testing implications

The manifest's compile-time half needs no test — a missing or extraneous entry is a build failure, full stop. Its runtime half is the required Tier A test from §3.2 (`17` in `tests/e2e/tier-a.test.ts`), registered in the required-test table in [`e2e-testing.md`](./e2e-testing.md) §2, rather than N per-method tests: the test is parametrized over `uiAdapterBindings`, so it automatically covers every future entry without being edited again — TypeScript's own exhaustiveness checking on its per-method `switch` fails the build if a new entry is added without a matching case.
