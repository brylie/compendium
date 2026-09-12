# Internal links — stable targets and explicit deletion handling

**Depends on:** [`data-model.md`](./data-model.md) §1/§3 (`page_link` blocks, `referencedRecordId`), [`markdown-transcoding.md`](./markdown-transcoding.md) (`[[Title]]` ⇄ `record:` link marks)

---

## 1. One canonical representation, two call sites

Compendium has exactly two ways to write an internal link, and both persist only a target ID — never a title:

- A **`page_link` block** stores its target on the block record's own `referencedRecordId` (Documents only, set today from the editor UI's document picker).
- An **inline `[[wiki link]]`** is an ordinary rich-text `link` mark whose href uses a `record:<id>` scheme (Documents or Collections; see `markdown-transcoding.md` for the Markdown ⇄ mark boundary).

Both resolve to a display title the same way, live, at read time — via `resolveInternalLinkTarget(doc, id)` in [`src/lib/data/links.ts`](../../src/lib/data/links.ts). That module is the one place "does this ID still name a Document or Collection, and what's it called now" is answered; `markdown-transcode.ts`, the `documents` service, and `BlockEditor.svelte` all call into it for display, and (since issue #62) `services/records.ts`'s `referencedRecordId` validation and `services/tokens.ts#createToken`'s Document/Collection grant-existence checks call into it for validation — every one of these rather than each re-deriving the answer. This is what makes renaming or moving the target a non-event: nothing that points at it needs to change, because nothing that points at it ever stored the title.

`src/lib/data/links.ts` also exports `listOutgoingLinks(doc, documentId)`, which walks a Document's own records (`page_link` blocks and inline `record:` marks alike) and resolves each to the same `{ id, kind, title } | undefined` shape. `listIncomingLinks(doc, targetId)` builds its reverse index from that same function on first use, then incrementally refreshes only a changed link-bearing record or source Document's metadata. It returns the referring Document, the exact referring block, and its live text context. Outgoing and incoming views therefore derive from one ID-backed representation rather than parallel ad hoc scans.

A `collection_view` block (see [`collection-views.md`](./collection-views.md)) also stores a target ID on `referencedRecordId` and reuses `resolveInternalLinkTarget` to resolve it, but it's deliberately not counted as a third kind of "internal link" above — it's an embed reference ("render this Collection here"), not a navigational one, and doesn't currently participate in `listOutgoingLinks`. Its target-resolution and deleted-target handling otherwise follow the exact same pattern as `page_link`'s (§2): the ID is preserved rather than cleared once the target Collection is deleted, and the block renders an explicit "deleted" state rather than reverting to its unconfigured picker.

## 2. Deleted targets are explicit, not silent

Before this feature, a `page_link` whose target had been deleted was indistinguishable from one that was never linked (both showed the "pick a document" picker), and a deleted wiki-link's target silently rendered its last-known title as if the link still worked. Neither state is acceptable: the first hides that a link needs fixing, the second actively lies.

`resolveInternalLinkTarget` returns `undefined` when the ID no longer resolves. Every render path treats that as a distinct third state, never folded into "unlinked" or silently ignored:

| Surface                                      | Unlinked (no target set)        | Linked, target exists                          | Linked, target deleted (broken)                                                  |
| -------------------------------------------- | ------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `page_link` block (`+page.svelte`)           | document picker `<select>`      | navigable link + "Change"                      | "Linked page was deleted" + "Change" — `referencedRecordId` is kept, not cleared |
| Inline wiki-link (`BlockEditor.svelte`)      | n/a (only exists once resolved) | real `<a href="/doc/…">`/`<a href="/table/…">` | muted, non-navigable `<span title="Linked page was deleted">`                    |
| `get_document` MCP output (`documents.ts`)   | `markdown: ''`                  | `markdown: '[[Title]]'`                        | `markdown: '[[Deleted page]]'`, plus an explicit `linkBroken: true` field        |
| `richTextToMarkdown` (agent-facing Markdown) | n/a                             | `[[Title]]`                                    | `[[Deleted page]]`                                                               |

`get_document`'s `linkBroken` field exists specifically so an MCP agent can detect a broken link programmatically, without string-matching the literal `"Deleted page"` marker text in the rendered Markdown.

## 3. Deleting a Document does not edit other Documents (deliberate)

`deleteDocument`/`deleteCollection` (`src/lib/data/records.ts`) delete only the target and, for a Document, its own descendant tree — they never scan the rest of the workspace to find and edit records that reference the deleted target. A page_link or wiki-link elsewhere becomes broken (§2) rather than being rewritten or removed by the delete itself. This is a deliberate choice, not an oversight:

- There is no reverse index yet — finding "every record that links to this ID" requires a workspace-wide scan of every Document's every record on every single delete. #21's backlink index is exactly the structure that makes this cheap; building one-off cascading cleanup ahead of it would mean either duplicating that index badly or accepting an O(records) delete.
- A silent cross-document edit as a side effect of deleting something else is a bigger surprise than a visibly broken link. The broken-link states in §2 are designed to be impossible to miss (an explicit label, not a blank field) specifically so this is safe to defer without leaving users guessing why a link silently disappeared.
- Revisit once #21 lands: with a reverse index in hand, either an explicit "find broken links" scan or opt-in cascading cleanup becomes a cheap, well-scoped addition rather than a workspace scan bolted onto every delete.

## 4. MCP authoring and repair for `page_link` targets

`create_record` and `write_record` (`mcp-tools.md`) accept an explicit `referencedRecordId` field, so an MCP agent can create and retarget a `page_link` block with the same safe-target semantics as the editor UI's document picker, not just read one:

- `create_record` sets a new `page_link` block's target in the same call — only accepted when `blockType` is `page_link` and `parentId` names a Document.
- `write_record` retargets an existing `page_link` block via the `referencedRecordId` field — a named field, not Markdown text, per this doc's "persist only a target ID" rule (§1). It's a metadata write, not a content write, so it needs no hold (same exemption `properties` already has) and is naturally idempotent.
- Both call sites run the same validation: the target must be an existing Document the caller can already reach. A target that's missing, not a Document, or outside the caller's token scope is rejected with one generic error — deliberately not distinguishing "doesn't exist" from "exists but forbidden," so a probing caller can't use the error to learn whether an ID it doesn't have access to even exists (mirrors `audit-coverage.md` §3's rule that a denial never reveals more than the caller already supplied).
- Deleting the target afterward still produces the explicit broken-link state in §2, not a cleared `referencedRecordId` — nothing about this capability changes that.

**Duplicate Document/Collection titles are still ambiguous on wiki-link _creation_ only** — parsing typed/pasted `[[Title]]` Markdown resolves the first title match, same as before this feature; an already-created link (ID-backed) is never affected by a later duplicate title, and this doesn't apply to `page_link` at all since it never resolves by title. Documented in `markdown-transcoding.md`.

## 5. Backlinks

Opening a Document shows a Backlinks panel (`BacklinksPanel.svelte`). It lists every `page_link` block and inline `record:` wiki-link in the workspace whose target ID matches that Document, with a link to the exact referring block (not just the referring Document) and the current text of that block as context.

Powered by `services/documents.ts#listBacklinks`, not `$lib/data/links.ts#listIncomingLinks`'s client-side incremental index: that index is scoped to whatever single `Y.Doc` it's built against, which — since each Document has its own shard (#120) — can only ever be the current Document's own shard, structurally unable to span the workspace. The Backlinks panel built on it was removed for exactly this reason when #120 shipped. `listBacklinks` instead fans out across every Document's own shard server-side, the same `fanOutCatalogedAndUncataloged` pattern `search.ts#searchWorkspace` already established (#191), calling the stateless `listOutgoingLinks(doc, documentId)` scan once per fanned-out Document rather than relying on any single Y.Doc's incremental index. The load is SSR-only, not live (same accepted tradeoff `+layout.server.ts`'s own `documents`/`collections` lists already make) — a new backlink appears on next navigation/refresh, not instantly, since re-running a workspace-wide scan on every Yjs observer tick isn't proportionate.

Each entry navigates via a `#block-<id>` fragment on the referring Document's URL, reusing the same navigate/reveal/temporary-highlight mechanism `SyncedBlockUsage.svelte`'s "used in N places" panel already established: a same-document link short-circuits into an in-place scroll/focus/highlight (`navigateToBlock`) instead of a full reload, a cross-document link is a real `<a href>` (preserving browser Back and keyboard activation), and a stale/deleted source block degrades safely to just opening the Document, since both the DOM lookup and the block-ref lookup behind the highlight are optional-chained.

`listBacklinks` is permission-filtered the same way `listDocuments` is: a source Document the caller can't reach never contributes a backlink entry, so a scoped MCP token (not currently exposed there — UI-only per its `serviceSurfaces` entry) couldn't use this to learn about content outside its grant if it ever were. The current personal-MVP UI's human caller is unscoped (Phase 0), so this is a no-op for the UI's own use — the load-bearing case is forward-looking.
