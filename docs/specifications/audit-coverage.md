# Audit coverage — closing the UI-mutation and denied-attempt gaps

**Depends on:** [`persistence.md`](./persistence.md) §1 (`audit_log` schema), [`service-layer.md`](./service-layer.md) (permission → mutate → audit contract), [`architecture.md`](./architecture.md) §1 (one shared `Y.Doc`)

---

## 1. The gap this closes

`src/lib/services/*.ts` is the one place a use case's full contract — permission check, mutate, `logAudit` — runs together (`service-layer.md`). That contract is correct for anything that reaches a service function. The gap: **most of the UI never reaches one.**

The block editor, Sidebar, and Table view call `src/lib/data/records.ts` directly against the browser's own `Y.Doc` (`createRecord`, `deleteRecord`, `updateRecordContent`, `setBlockType`, `setRecordChecked`, `setRecordReferencedId`, `updateDocumentTitle`, and more — see `src/routes/doc/[id]/+page.svelte`, `src/lib/components/Sidebar.svelte`, `src/routes/table/[id]/+page.svelte`). Only Document/Collection _creation_ goes through a server route action into the service layer; every other UI mutation — including deleting a document from the Sidebar — reaches the server purely as a y-websocket sync update, with no service function and no `logAudit` call anywhere in the loop. Before this feature, none of that had an audit trail at all.

The fix is a generic observer on the server's own `Y.Doc` (`src/lib/server/audit-observer.ts`), not a rewrite of every UI call site — the whole point of Yjs here is that the UI keeps working offline-tolerant and low-latency by mutating its local doc directly; routing every keystroke through an HTTP round-trip to a service function would sacrifice exactly that (see `architecture.md`'s core bet that MCP and UI writes are indistinguishable and live).

## 2. How the observer attributes without new tagging

`src/lib/mutation-origin.ts` defines the closed mutation-origin contract. The WebSocket server uses a named `remote-ui` origin, the browser uses `local-ui`, services use `service`, and migration/replay/undo-redo/test paths have their own explicit origins. `attachDocAuditObserver` rejects an unrecognized origin rather than inferring meaning from nullability or object shape.

- `service`, `migration`, `replay`, and `undo-redo` are intentionally not observer-audited. Service calls retain their own `logAudit` operation, preventing duplicates.
- `transaction.origin` is anything else → a real y-websocket client wrote directly to the doc. The observer resolves what changed and logs it, attributed to `CURRENT_USER` (Phase 0/1 is single-tenant — every live UI connection is the one workspace owner; see `service-layer.md` §3's note that UI writes are currently unscoped).

Resolving _what_ changed walks `transaction.changed` (the Yjs-native per-transaction diff): a key added/removed directly on `documents`/`collections`/`records` (the three top-level maps) is a whole entry created or deleted; anything else is walked up via `.parent` until it reaches one of those three maps, attributing the change to whichever entry owns it — e.g. a record's `content` Y.Text's parent is that record's own `Y.Map`, whose parent is the top-level `records` map. A document's `recordIds` reorder (dragging a block, or a record being added/removed from it) resolves to that _document_, not the moved record — reordering is a structural fact about the document distinct from the record's own content, and is logged as its own `update_document`/`update_collection` event alongside whatever `create_record`/`delete_record` event fired in the same transaction.

## 3. What is and isn't audited, and why

<!-- prettier-ignore -->
| Action | Audited? | Actor attribution |
| --- | --- | --- |
| Any MCP tool call that mutates state (`create_record`, `write_record`, `delete_record`, `create_document`, `move_document`, `delete_document`, `update_document_title`, `create_collection`, `delete_collection`, `update_collection_title`, `hold_records`, `release_records`) | Yes — via the service layer's own `logAudit` call, unchanged by this feature | `human-via-client` (token's `clientLabel`) |
| `get_document`, `query_collection`, `search_workspace` | Yes, unconditionally — **for any caller**, human UI or MCP token alike | Whichever caller invoked it |
| `list_documents`, `list_collections` | No, deliberately | n/a |
| A denied MCP attempt (`requireAccessibleParent`/`requireAccessibleRecord` throwing `PermissionDeniedError`) | Yes, as `<action>_denied` | `human-via-client` |
| A direct UI mutation to a record's content/fields/blockType/etc. (no MCP, no service call) | Yes, via `attachDocAuditObserver`, debounced (§4) | `CURRENT_USER` (`{ kind: 'human', userId: 'local' }`) |
| A direct UI creation/deletion of a Document, Collection, or record | Yes, via `attachDocAuditObserver`, immediately (not debounced) | `CURRENT_USER` |
| A document/collection's `recordIds` reorder from the UI (drag-and-drop, or an incidental side effect of a record create/delete) | Yes, as `update_document`/`update_collection`, via `attachDocAuditObserver` | `CURRENT_USER` |

`get_document`/`query_collection`/`search_workspace` audit **regardless of caller** — this was already the design before this feature (see `tests/e2e/tier-a.test.ts`'s manifest-wiring check, which asserts this for a plain human caller) and this work didn't change it: reading a specific target's actual content is the security/trust-sensitive action worth a trail, whether a human or an agent did it. `list_documents`/`list_collections` are excluded on purpose: they're bare existence listings (no content revealed), called on every sidebar render and page navigation — auditing them would mean one audit row per navigation for a human just using their own workspace, for no proportionate trust benefit. This split is deliberate, not an oversight; don't "complete" it by adding logging to the list endpoints.

Denied MCP attempts (new in this feature) are gated to token callers only — `requireAccessibleParent`/`requireAccessibleRecord` never deny `CURRENT_USER` in the first place (single-tenant UI is unscoped), so there's nothing meaningful to log on that path. A denial log entry never contains more than the `targetRecordId` the caller already supplied in their own request — no title, content, or other metadata about the denied target is added, so nothing new leaks to whoever eventually reads the audit trail (in this single-tenant design, only the workspace owner — see `persistence.md` §1).

## 3.1 In-context block provenance

The Document editor projects each block's existing `lastEditedBy` and `lastEditedAt` CRDT fields beside the block. These fields are updated for direct UI typing as well as structured UI, MCP, and agent writes, so the projection stays live as collaborative updates arrive. A synced block projects the referenced source record rather than its wrapper, because its editable `Y.Text` and audit events belong to that source.

The visible provenance link opens `/audit?targetRecordId=<record-id>`, which filters the shared audit trail to the corresponding record without creating a separate block-history store. The audit page preserves this record scope while an actor filter changes and offers an explicit All history link to clear it. Legacy records without a valid attribution projection instead show `Editing history unavailable`; both the attribution and this fallback are announced politely when live collaboration changes them.

## 4. Volume control: immediate vs. debounced

Create and delete are discrete, comparatively rare events — logged immediately. A content edit is not: `BlockEditor.svelte` writes to `Y.Text` on every browser `input` event, so typing one word could otherwise produce one `update_record` audit row per keystroke. `attachDocAuditObserver` coalesces these: an `update_record`/`update_document`/`update_collection` event is scheduled on a 3-second debounce per `(kind, id)` pair, restarting on every subsequent nested change to that same entry, and only actually written once the entry goes quiet. This keeps read/write-event volume bounded per burst of activity rather than per keystroke, directly addressing the "read-event volume remains manageable" requirement, while still recording that an edit happened and roughly when.

Two operational details this implies:

- `flushPendingAuditEvents()` (exported from `audit-observer.ts`) writes any pending debounced events immediately instead of waiting out the window — called on process shutdown (`ydoc.ts`'s `SIGINT`/`SIGTERM` handler) so a debounced edit made just before shutdown isn't lost, and available to tests that don't want to wait out real time.
- The audit debounce is in-memory and per-process; graceful shutdown flushes it. Catalog projection does **not** share this limitation: direct UI metadata changes project synchronously (§3).

Retention itself (pruning old rows) is out of scope for this feature — `queryAuditLog`'s existing `since`/`until`/`limit` filtering (`persistence.md` §1, `src/lib/server/audit.ts`) is the only volume control today beyond the debounce above; see the tracked follow-up issue for periodic pruning.

## 5. Testing

- `src/lib/server/audit-observer.test.ts` — unit tests cover named remote/service/test origins, rejection of unknown origins, debounce coalescing, explicit flush, and parent record-order attribution.
- `src/lib/services/services.test.ts` — the new denied-attempt audit tests (`create_record_denied`, `get_document_denied`, no denial logged for a human caller, a denial for a nonexistent record carries no extra metadata).
- `tests/e2e/tier-a.test.ts` (#11) — a _real_ y-websocket client (the same harness every other Tier A test uses) mutates its own `Y.Doc` directly, with zero MCP/service-layer calls, mirroring exactly what `BlockEditor.svelte`/`Sidebar.svelte` do today; asserts the server's `audit_log` picks up `create_document`, `create_record`, a debounced-then-flushed `update_record`, and `delete_record`, each written exactly once, and that the live record projection carries the editor and newer timestamp.
