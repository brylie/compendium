# Specification — Service Layer (centralizing business logic)

**Status:** Draft
**Depends on:** [`mcp-tools.md`](./mcp-tools.md) (MCP tool surface), [`persistence.md`](./persistence.md) §1 (persistence/audit) — this doc extends, not replaces, those; [`agent-workspace-prd.md`](../agent-workspace-prd.md)'s "Permissions model" and "Audit log" requirements are the acceptance bar everything here is built to satisfy.
**Motivated by:** a live Phase 1 review that found the `create_document` MCP tool granting itself access to a newly-created document in a way that never persists (see §1 below) — a bug that exists specifically because no single piece of code owns "what must always happen when a document is created."

---

## 1. Problem

`src/lib/data/records.ts` is, by design, the shared low-level data-access layer both the SvelteKit UI and the MCP server call into (`architecture.md` §2). That part of the architecture is correct and should stay. What's missing is a layer _above_ it: today, every call site that performs a write is individually responsible for remembering to also (a) check permissions, (b) log the action to the audit trail, and (c) do whatever else that specific write implies (e.g. a token that creates a document needs its own access grant updated). There is no enforcement that a given use case always does all of its required side effects — it's up to whoever writes that call site to remember, correctly, every time.

Concretely, as of the M2 (Sidebar + hierarchy) milestone, "create a document" is implemented three separate times, with three different completeness levels:

| Call site                                                    | Permission check               | Audit log                                                        | Grants creator access                                                            |
| ------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/routes/+page.server.ts` (`createDocument` action)       | n/a (top-level, single-tenant) | ✅                                                               | n/a (human, not token-scoped)                                                    |
| `src/routes/api/documents/+server.ts`                        | n/a (top-level, single-tenant) | ✅                                                               | n/a                                                                              |
| `src/lib/mcp/server.ts` (`create_document` tool)             | ✅ (when nested)               | ✅                                                               | ❌ — attempted, but mutates a discarded per-request object; never reaches SQLite |
| `src/lib/components/Sidebar.svelte`'s fetch-failure fallback | n/a                            | ❌ — writes straight to the client `Y.Doc`, no audit call at all | n/a                                                                              |

Three of four call sites silently diverge from what "create a document" is supposed to guarantee. This is a structural problem, not a one-off bug: the next new write operation (`move_document`, a future `create_collection_row`, anything) is exactly as likely to under-implement its required side effects, because nothing forces otherwise.

## 2. Decision

Introduce a **service layer** between `records.ts` (pure CRDT primitives, no policy) and the two thin adapters (SvelteKit routes/actions, MCP tool handlers). Each use case — "create a document," "move a document," "write a record," "hold records" — gets exactly one implementation, in the service layer, that owns its full contract: permission check, mutation, audit log, and any other required side effect, all called from one place, in a fixed order.

**Not a literal atomic transaction.** The Y.Doc mutation and the SQLite writes (access grant, audit log) are two different storage engines with no shared transaction boundary — a service function that mutates the CRDT successfully and then throws on the SQLite step (e.g. `grantDocumentAccess`) leaves the document created but its grant/audit entry missing, with no automatic rollback or retry. "One transaction" in the sense meant here is "one function is the single owner of the full contract, called synchronously end-to-end" — not a cross-engine ACID guarantee. If that gap matters in practice (e.g. `createDocument` partially failing leaves an inaccessible orphan document), it needs an explicit compensation step or a change to the persistence boundary (see [`persistence.md`](./persistence.md)); Phase 0/1 accepts the gap as-is, consistent with single-tenant, local-trust scope.

```
src/lib/data/records.ts        — pure Yjs/CRDT operations. No permission checks, no audit
                                  calls, no actor-awareness beyond stamping createdBy/
                                  lastEditedBy. Unchanged in spirit from today.
        ↓
src/lib/services/*.ts          — one module per aggregate (documents, records, collections,
                                  holds, tokens). Each exported function takes an actor/
                                  token and validated input, and is the ONLY place that:
                                    1. checks permission (reuses tokenAllowsParent /
                                       requireAccessibleParent style helpers, moved here)
                                    2. calls into records.ts to mutate the Y.Doc
                                    3. calls logAudit
                                    4. performs any other required side effect
                                       (e.g. persisting a token's new document grant)
        ↓                                           ↓
src/lib/mcp/server.ts          src/routes/**/+page.server.ts, +server.ts
(tool handlers: parse input →  (route handlers: parse request → call service →
 call service → format result)  respond/redirect)
```

**Rule going forward: MCP tool handlers and SvelteKit route/action handlers must not call `records.ts` or `logAudit` directly.** If a handler needs to do either, that's a sign the operation belongs in the service layer, not inline in the handler.

`Sidebar.svelte`'s client-side CRDT calls (`createDocument(ydoc, ...)`, `deleteDocument(ydoc, ...)`, etc., used for the _live-reactive_ read path and legitimate direct-to-Yjs UI writes) are a separate, already-correct pattern per `architecture.md` §2 ("Shared `lib/yjs-client.ts`... UI and MCP code share one data-access layer") — those stay. What changed is specifically the _fallback_ path that used to bypass the network API (and therefore the audit log) on a fetch failure: that fallback has been removed (see §4) — a failed `/api/documents` or `/api/collections` request now surfaces as an error to the user instead of silently falling through to an unaudited direct `Y.Doc` write.

## 3. Module layout

```
src/lib/services/
  documents.ts    createDocument(actor, input) → DocumentMeta
                  moveDocument(actor, documentId, { parentDocumentId?, afterDocumentId? }) → void
                  deleteDocument(actor, documentId) → void
  records.ts      createRecord(actor, input) → WorkspaceRecord
                  writeRecord(actor, recordId, { markdown? | properties? }) → void
                  deleteRecord(actor, recordId) → void
  holds.ts        holdRecords(actor, recordIds) → { granted, denied }
                  releaseRecords(actor, recordIds) → void
  collections.ts  createCollection(actor, input) → CollectionMeta
                  queryCollection(actor, collectionId, filter?) → WorkspaceRecord[]
  search.ts       searchWorkspace(actor, query) → { recordId, snippet }[]
```

Each function's first parameter is whatever identifies the caller for permission purposes — an `AccessToken` for MCP-originated calls, the fixed `CURRENT_USER` `ActorId` for Phase 0/1 UI calls (see `data-model.md` §1's `ActorId` union; this doesn't need to change). Where MCP and UI calls to the "same" use case need different permission rules (e.g. UI writes are currently unscoped, single-tenant; MCP writes are token-scoped), the service function is the one place that branches on that — not duplicated per adapter.

## 4. What this fixes, concretely

- **The `create_document` self-grant bug.** `services/documents.ts#createDocument` becomes the single place that creates the document _and_ persists the calling token's new grant (via a real `grantDocumentAccess(tokenHash, documentId)` function added to `tokens.ts`, doing an actual `UPDATE access_tokens SET allowed_document_ids = ...`) _and_ logs the audit entry, as one unit. The MCP tool handler shrinks to: verify token → call `createDocument(token, input)` → return result.
- **The Sidebar audit-log gap.** Now that the MCP/route handlers are the only sanctioned way to reach a mutating service function over the network, `Sidebar.svelte` no longer has a lower-level function to silently fall back to on a fetch failure — that fallback (finding #4) has been removed rather than left as an isolated patch.
- **Future write operations** (starting with `move_document`, from the same review) get built against this layer from day one instead of accumulating the same inconsistency a fourth time.

## 5. Migration plan

Incremental, not a rewrite:

1. Add `src/lib/services/documents.ts` with `createDocument` and `moveDocument` first — these are what the current fix list needs immediately (findings #1 and #3).
2. Point `create_document`'s MCP handler and both existing document-creation route handlers (`+page.server.ts`, `api/documents/+server.ts`) at the new service function; delete the now-redundant inline permission/audit logic from each.
3. Remove `Sidebar.svelte`'s fetch-failure fallback (finding #4) now that there's nothing lower-level for it to have been calling anyway.
4. Migrate the remaining use cases (`records.ts`, `holds.ts`, `collections.ts`, `search.ts` services) opportunistically — each time an existing MCP tool or route handler is touched for another reason, lift its logic into the corresponding service function rather than leaving it inline. No need to block other Phase 1 work on migrating everything at once.

## 6. Testing implications

Service functions are the natural unit-test seam going forward: a test for `services/documents.ts#createDocument` can assert all three required side effects (document exists, audit entry exists, token's persisted grant includes the new ID) in one place, against an in-memory `Y.Doc` and a real (test) SQLite connection — no need to spin up the MCP or HTTP layer just to verify business-rule completeness. Protocol-boundary correctness (does a _second, independent_ MCP call actually see the persisted grant) is still the job of the E2E parity tests — see [`e2e-testing.md`](./e2e-testing.md); the service layer makes those tests more likely to pass, it doesn't replace the need for them.
