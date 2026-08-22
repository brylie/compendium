# Specification — Service Layer Manifest (static parity enforcement)

**Status:** Draft
**Depends on:** [`service-layer.specification.md`](./service-layer.specification.md) §2–§3 (the `src/lib/services/*.ts` module layout this doc assumes exists) — this is an addendum, not a replacement. Written as a **separate file on purpose**: the service layer is actively being implemented against that spec right now, and editing it mid-implementation would move the target the implementing agent is building against. This doc layers on top once (or as) that module layout lands.
**Motivated by:** a question about whether MCP/UI parity can be enforced statically rather than by convention — i.e. can the compiler catch "a new service method exists but nothing exposes it," the same way `switch`-exhaustiveness catches an unhandled enum member.

---

## 1. Problem

`service-layer.specification.md` fixes _internal_ completeness: once a use case (e.g. `createDocument`) is implemented as a service function, that one implementation always does its full contract (permission check, mutation, audit, side effects) — because there's only one of it.

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
2. **A wiring-check test for the UI side.** SvelteKit's file-based routing means routes/actions can't be generated the same way (each often has form-specific validation, redirects, or multi-step flows). Instead, add a Tier A test (see [`e2e-testing.specification.md`](./e2e-testing.specification.md) §2) that walks `serviceSurfaces`, and for every `ui: true` entry, drives the real route/action through the test harness and asserts the underlying service function actually ran (e.g. by asserting its observable effect — the audit entry, the persisted state — the same way other Tier A tests already assert protocol-boundary correctness). This is the same "second, independent call observes the real effect" pattern already established for the MCP side; applying it to the manifest costs one parametrized test, not N bespoke ones.

Static typing alone gets you "nothing was forgotten from the list." It cannot get you "the thing on the list is wired correctly" — that residual has to be a test, and the manifest is what makes that test parametrized and complete instead of another hand-maintained list.

## 4. What this fixes, concretely

- **Silent omission.** Today, shipping a new service method without an MCP tool or UI route compiles fine and looks done. With the manifest, it's a compile error until someone makes an explicit `{ mcp: false, ui: false }` (or `true`) decision — the gap becomes visible instead of implicit.
- **Recurrence of the self-grant bug's shape, elsewhere.** The original bug wasn't really about grants — it was "a call site claimed to do something it didn't." The manifest doesn't stop a call site from being wrong internally (that's §2's job in `service-layer.specification.md`), but the generated-MCP-table half of §3 above removes the possibility of an MCP tool silently not calling its service function at all, which is the most severe version of that failure mode.
- **A checklist that can't go stale.** `phase-1-plan.md`'s "Follow-up from architecture review" note and `phase-2-plan.md`'s M1 checklist are both static documents that require someone to remember to update them. `serviceSurfaces` is the same information, but the compiler checks it on every build.

## 5. Migration plan

Additive, and sequenced strictly after `service-layer.specification.md`'s M1 gives it something to point at — this is not a prerequisite for that work, don't block M1 on it:

1. Once `src/lib/services/documents.ts` exists (service-layer spec §5 step 1), add `src/lib/services/manifest.ts` covering just that module — `ServiceMethod` and `serviceSurfaces` don't need every aggregate populated on day one, only the ones that exist yet.
2. Regenerate the MCP tool registrations for `documents.*` from the manifest (§3.1) as part of the same work that points `create_document`'s handler at the new service function (service-layer spec §5 step 2) — this is the natural moment, since that handler is already being rewritten.
3. Add the one parametrized UI wiring-check test (§3.2) to the Tier A suite once `tests/e2e/harness.ts` exists (`e2e-testing.specification.md` §3 / `phase-2-plan.md` M2).
4. Extend `serviceModules` / `serviceSurfaces` to `records`, `holds`, `collections`, `search` opportunistically, in step with `service-layer.specification.md` §5 step 4's own opportunistic migration — the two migrations track each other module-by-module.

## 6. Testing implications

The manifest's compile-time half needs no test — a missing or extraneous entry is a build failure, full stop. Its runtime half is exactly one new required Tier A test (§3.2), added to the required-test table in [`e2e-testing.specification.md`](./e2e-testing.specification.md) §2 once this lands, rather than N per-method tests: the test is parametrized over `serviceSurfaces`, so it automatically covers every future method without being edited again.
