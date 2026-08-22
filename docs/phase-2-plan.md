# Phase 2 Plan — Service layer & testing

Phase 1 (M1–M3) gets the single-user experience solid: design system, navigable document hierarchy, full block-type set. This phase doesn't add user-visible features — it hardens the architecture underneath what Phase 1 built, on the same single-user, SQLite-backed foundation, before Phase 3 extends the UX further. The trigger for scoping this phase now rather than later: a Phase 1 architecture review (see `phase-1-plan.md`'s M2 follow-up note) found a real bug — an MCP `create_document` grant that never persists — that neither the existing unit tests nor manual UI testing could have caught, and traced it to a structural gap (no single place owns "what a write must always do") rather than a one-off mistake. Both milestones below exist to close that gap and make sure it doesn't recur.

**Depends on:** [`service-layer.specification.md`](./service-layer.specification.md) (M1), [`e2e-testing.specification.md`](./e2e-testing.specification.md) (M2). Both specs contain the full design rationale — this doc is just the "turn it into milestones" step, same relationship `phase-1-plan.md` has to `phase-1-notes.md`.

---

## M1 — Service layer

Per `service-layer.specification.md` §2–§5. Introduces `src/lib/services/*.ts` between `records.ts` (pure CRDT, unchanged) and the MCP/route adapters (which become thin routing), so permission checks, audit logging, and any other required side effect for a given write are implemented exactly once per use case.

- [ ] `src/lib/services/documents.ts` — `createDocument`, `moveDocument`, `deleteDocument`. Build these first: `createDocument` is where the known self-grant bug gets fixed for real (add `grantDocumentAccess(tokenHash, documentId)` to `tokens.ts`, call it from the service function, not the MCP handler), and `moveDocument` is the new capability that exposes `records.ts`'s already-implemented but currently-unused `updateDocumentParent` as an MCP tool (`move_document`) and, if time allows, sidebar drag-and-drop.
- [ ] Point `create_document`'s MCP handler and both existing document-creation routes (`+page.server.ts`, `api/documents/+server.ts`) at the new service function; delete the now-redundant inline permission/audit logic from each.
- [ ] Remove `Sidebar.svelte`'s fetch-failure fallback that writes directly to the client `Y.Doc` (it bypasses the audit log and has no service-layer equivalent to fall back to once this lands) — surface the failure to the user instead.
- [ ] `src/lib/services/records.ts`, `holds.ts`, `collections.ts`, `search.ts` — migrate opportunistically per the spec's §5 migration plan (each time an existing MCP tool or route handler is touched for another reason, lift its logic into the corresponding service function). Not required to be exhaustive before M2 starts.
- **Done when:** no MCP tool handler or SvelteKit route/action handler calls `records.ts` or `logAudit` directly — every mutating operation goes through `src/lib/services/`, per the rule in `service-layer.specification.md` §2.

## M2 — E2E test harness + Tier A parity tests

Per `e2e-testing.specification.md` §2–§4. The tier that actually crosses the MCP/y-websocket transport boundary with two independent real clients — the shape of test that would have caught the M1 bug before it shipped.

- [ ] `tests/e2e/harness.ts` — boots the real server on an ephemeral port against a temp SQLite file, exposes `createTestToken`, `getMcpClient`, `getYjsClient`, `waitForCondition`, per spec §3.
- [ ] Write the full required-test list from spec §2's table: MCP write → Yjs client observes it and vice versa; MCP `create_document` (nested) → a **second, independent** MCP call on the new document succeeds (the regression test for the M1 bug); hold/release and cursor-presence-as-implicit-hold behavior; TTL auto-revert; permission-denied across scoped tokens; audit log entries for every write path (including the removed-fallback case from M1); `move_document` permission boundaries once it exists.
- [ ] Wire into `npm run test` and CI — Tier A uses Vitest, no browser, should run on every PR at normal unit-test speed.
- **Done when:** every PRD acceptance criterion listed in spec §2's table has a passing Tier A test, and CI fails if any of them regress.

## M3 — Tier B (Playwright, DOM-visible behavior only)

Per `e2e-testing.specification.md` §2 (Tier B) and §4. Deliberately small — only for behavior Tier A structurally can't see because it never renders a DOM.

- [ ] Held-block placeholder (shimmer + avatar) appears/disappears correctly when triggered by a real MCP `hold_records`/write call against a document open in a real browser session.
- [ ] Sidebar tree updates live, correctly nested, when a document is created via MCP `create_document` — no manual refresh.
- **Done when:** both scenarios pass in CI; resist the urge to grow this tier into general UI-test coverage — anything that doesn't need a rendered DOM belongs in M2's Tier A instead.

---

## Sequencing notes

- M1 before M2: the Tier A regression test for the create_document bug is most valuable once it's asserting against the real fix (the service layer), not the broken code — write the fix first, then the test that proves it, then keep the test as the permanent regression guard.
- M3 depends on M1 and M2 both being substantially done — it needs real MCP tool behavior (M1) and the harness (M2) to drive its triggering calls.
- This phase is a prerequisite for Phase 3, not parallel to it: `phase-3-plan.md`'s UX work will be built and reviewed against the same architecture and test discipline this phase establishes, so building UX first and hardening later would mean redoing the review this phase exists to avoid.
