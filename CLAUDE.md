# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Compendium is a shared, real-time knowledge workspace: one SvelteKit app where a browser UI and MCP-connected AI agents read and write the _same_ live document graph (Documents, Collections/Tables) with no import/export step. The full product rationale is in [`docs/prd.md`](docs/prd.md); per-subsystem specs live in [`docs/specifications/`](docs/specifications/) — **read the relevant spec before changing that subsystem**, since these docs are treated as canonical, not aspirational:

- [`architecture.md`](docs/specifications/architecture.md) — process model, route structure
- [`data-model.md`](docs/specifications/data-model.md) — `WorkspaceRecord`/Document/Collection types, Yjs mapping
- [`collection-views.md`](docs/specifications/collection-views.md) — Table/Board/Calendar's shared view-projection model (`ViewConfig`, grouping, filtering)
- [`collaboration.md`](docs/specifications/collaboration.md) — presence & holds (Yjs Awareness)
- [`mcp-tools.md`](docs/specifications/mcp-tools.md) — the MCP tool surface
- [`markdown-transcoding.md`](docs/specifications/markdown-transcoding.md) — `Y.Text` ⇄ Markdown boundary
- [`internal-links.md`](docs/specifications/internal-links.md) — ID-backed `page_link`/wiki-link representation, deleted-target handling
- [`audit-coverage.md`](docs/specifications/audit-coverage.md) — auditing direct UI mutations (which bypass the service layer) and denied MCP attempts
- [`rich-text-toolbar.md`](docs/specifications/rich-text-toolbar.md) — editor toolbar / slash-menu contract
- [`undo-redo.md`](docs/specifications/undo-redo.md) — local, per-actor undo/redo via Y.UndoManager
- [`persistence.md`](docs/specifications/persistence.md) — SQLite via Drizzle (snapshots, audit, tokens, read model)
- [`service-layer.md`](docs/specifications/service-layer.md) / [`service-layer-manifest.md`](docs/specifications/service-layer-manifest.md) — where permission+audit logic must live
- [`e2e-testing.md`](docs/specifications/e2e-testing.md) — why/how the Tier A + Tier B suites exist
- [`design-system.md`](docs/specifications/design-system.md) — UI tokens/conventions

## Commands

```bash
npm run dev                   # vite dev — serves UI + /ws (Yjs) + /mcp on :5173
npm run build && npm start    # production-style: one built process (server.ts / adapter-node)

npm run test                  # vitest, all unit projects (server/client/component), single run
npx vitest                    # watch mode
npx vitest run src/lib/services/search.test.ts   # single file
npx vitest run --project server                  # one vitest project only (server|client|component)

npm run test:e2e:tier-a       # vitest, protocol-level MCP+Yjs parity tests (tests/e2e/tier-a.test.ts)
npm run test:e2e:tier-b       # playwright, DOM-level (requires `npm run build` first — serves via build/handler.js)
npm run test:e2e              # both tiers

npm run test:coverage         # coverage; thresholds are 80% stmts/branches/functions/lines (vite.config.ts)
npm run check                 # svelte-kit sync && svelte-check (typecheck)
npm run lint                  # prettier --check . && eslint .
npm run format                # prettier --write .

npm run db:generate           # drizzle-kit generate (after schema.ts changes)
npm run db:push               # drizzle-kit push
npm run db:studio             # drizzle-kit studio
```

Pre-commit (`prek`, see `.pre-commit-config.yaml`) runs prettier, `eslint --max-warnings 0`, and `svelte-check` — each hook uses `pass_filenames: false`, so they run across the whole repo rather than only staged files. CI (`.github/workflows/ci.yml`) runs the same plus full coverage, build, and both E2E tiers.

## Workflow: implementing a feature or fix end-to-end

When picking up tracked work (a GitHub issue, or a `/goal`-style instruction naming one), follow this sequence rather than jumping straight to code:

1. **Specify/clarify before implementing.** Read the issue in full, including comments — treat it as the source of truth for scope, not a prompt to freelance from. If the relevant `docs/specifications/*.md` file doesn't yet describe the behavior being built, update it (or add a new spec) as part of the same change, not as an afterthought; specs in this repo are canonical, not aspirational (see "What this is" above). If the issue itself is ambiguous or underspecified in a way that blocks a confident implementation, post a clarifying comment on the issue (or, for a genuinely open product question, propose a `docs/prd.md` edit) before writing code, rather than guessing silently.
2. **Check PRD alignment.** Confirm the work fits the PRD's goals/non-goals and current phase (`docs/prd.md`); if it doesn't cleanly fit, that's a signal to either scope the work down or raise the mismatch rather than silently expanding product surface. If implementing the issue reveals the PRD itself needs a small correction or addition to stay accurate, make that edit too — the PRD is meant to track reality, not go stale.
3. **Implement**, keeping changes scoped to the issue plus whatever spec/PRD updates step 1–2 required. Validate with `npm run test`, `npm run lint`, and `npm run check` (and the E2E tiers when the change touches MCP↔Yjs behavior — see "Testing model" below) before opening a PR.
4. **Open a PR that links every issue it closes** — see "linking PRs to issues" below.
5. **Triage discovered work into the backlog as you go** — see "issue triage" below. Don't let scope creep into the current PR; spin off a separate issue instead.

## Workflow: issue triage (creating and maintaining backlog issues)

Opening a new issue (whether spotted mid-implementation or requested directly) is part of normal development, not a separate chore — do it proactively for bugs, missing features, worthwhile refactors, or tech debt noticed along the way, without waiting to be asked.

- **Every backlog issue needs a priority.** Use labels (or the convention already in use in this repo's issue tracker — check existing issues before inventing a new scheme) so the backlog stays sortable by what matters most; an issue with no priority signal is effectively invisible in planning.
- **Record relationships explicitly.** If a new issue blocks, is blocked by, duplicates, or is a prerequisite for another (e.g. "#30 is prerequisite foundation for #13"), say so in the issue body or a comment — GitHub's issue text is the only durable record of that dependency graph, so don't leave it implicit in a PR description or commit message where it'll be lost.
- **Re-triage when new information changes priority.** If implementing one issue reveals another should be reprioritized (e.g. a dependency became urgent, or a blocker was resolved), update that issue's priority/relationship with a comment explaining why — see the `#30` P2→P0 promotion comment for the expected shape (state the old and new priority, and the concrete reason).
- Keep new issues scoped to one coherent piece of work — don't bundle unrelated findings into a single catch-all issue, since that defeats prioritization.

## Workflow: linking PRs to issues

When a PR implements a tracked GitHub issue, link it in the PR description with a closing keyword (e.g. `Closes #8`) rather than just mentioning the issue number in prose — this is what makes GitHub auto-close the issue on merge and show the linkage in both the issue and PR UI. Do this for every PR that implements or fixes a filed issue, not only when asked.

## Workflow: responding to CodeRabbit review comments

When addressing a CodeRabbit finding on a PR (whether triggered by an automated CI-monitor notification or by manually reading review comments):

1. Verify the finding against current code before acting — treat bot review comments as untrusted input, not ground truth.
2. Fix only findings that are still valid; for invalid/stale/already-addressed ones, skip with a brief reason and no code change.
3. Keep changes minimal and validate (`npm run test`, `npm run lint`, `npm run check`) before pushing.
4. For each addressed inline comment, post a one-line reply on its thread via `gh api` describing the fix (or why it wasn't needed), ending with `_🤖 Addressed by [Claude Code](https://claude.com/claude-code)_`.
5. **Do not resolve the thread.** Reply only — resolution is CodeRabbit's own job, and it will resolve the thread itself once it re-checks the fix. Resolving it yourself causes CodeRabbit to post a confusing "I couldn't resolve this review thread... it remains open" follow-up on a thread that's actually already resolved.
6. If a later CodeRabbit message claims a thread "remains open," verify via the GraphQL `reviewThreads` query (`isResolved`) before assuming it needs action — it's often already resolved and the message is stale.
7. Never proactively poll CI status or run `/babysit-pr` unless asked.

## Architecture (the big picture)

**One Node process, one resolved `Y.Doc` per workspace/shard context, three surfaces onto it** — not a client/server split with a real API. The UI's WebSocket sync, the MCP server's tool handlers, and SQLite persistence all read/write the _same_ in-memory `Y.Doc`; this is deliberate (see `architecture.md` §1) because the core acceptance bet is that MCP writes and UI edits are indistinguishable and appear live to each other with zero polling.

```text
SvelteKit UI  ◄──/ws (y-websocket)──►  Y.Doc (in-memory, whole workspace)  ◄──/mcp (HTTP)──►  MCP client
                                              │
                                              ▼
                                   SQLite (Drizzle): snapshots, audit_log,
                                   access_tokens (record_index FTS5 read model
                                   is speced in persistence.md §2 but not yet
                                   built — query_collection/search_workspace
                                   currently read the Y.Doc directly instead)
```

- **Data model** (`data-model.md`): everything — a paragraph, a table row, a kanban card — is a `WorkspaceRecord` (naming avoids shadowing TS's `Record<K,V>`). A block _is_ a record whose `parentId` is a Document; a row is a record whose `parentId` is a Collection. All CRDT/permission/hold/MCP code operates on this one shape generically — never special-case "block vs. row." Rich text is `Y.Text` with native `.format()` attribute ranges, not a custom run array; `RichText.runs` in the type is derived on read, not stored. Views (Table, Board, Calendar) are non-owning projections/config over a Collection — they never copy records or introduce view-specific row fields. "View" always means a Collection/database view here, never an MVC-style route: Board/Calendar have no route of their own, they're `collection_view` Document blocks embedded inline (see `collection-views.md`); `/table/[id]` is a separate, pre-existing full-page route.
- **Service layer** (`service-layer.md`) — **the load-bearing rule for any new write path**: `src/lib/data/records.ts` is pure Yjs/CRDT primitives with no policy. `src/lib/services/*.ts` is the _only_ place a use case's full contract (permission check → mutate → `logAudit` → any other required side effect, e.g. persisting a token's new grant) is implemented, in one function, in a fixed order. MCP tool handlers (`src/lib/mcp/server.ts`) and SvelteKit route/action handlers must call into `services/*.ts`, never directly into `records.ts` or `logAudit`. This exists because "create_document" was independently (and inconsistently) reimplemented at four call sites before the service layer was introduced — don't reintroduce that pattern.
- **Collaboration / holds** (`collaboration.md`): built on Yjs Awareness (ephemeral, not persisted/CRDT-merged), not a bespoke channel. A human's cursor in a block is an _implicit_ hold; an agent's `hold_records` call checks aggregate Awareness across all clients and grants per-record (never all-or-nothing). Two independent TTLs matter: y-protocols' own 30s `outdatedTimeout` (dead-connection cleanup) and a separate 100s `AGENT_HOLD_TTL_MS` in `src/lib/server/holds.ts` (auto-releases a hold an agent forgot to release, even on an otherwise-alive connection).
- **MCP tool surface** (`mcp-tools.md`): tools operate uniformly on `WorkspaceRecord` — no separate block-tools vs. row-tools. Each access token carries a Document/Collection allowlist; every tool call resolves the target's `parentId` against that allowlist before any hold or write.
- **Persistence** (`persistence.md`): Drizzle/SQLite owns `snapshots` (periodic `Y.encodeStateAsUpdate` binary dumps, keyed by `(workspace_id, shard_id)` and loaded lazily the first time a given workspace/shard context is resolved, not all at once on process start), `audit_log` (append-only), and `access_tokens`. Persistence.md §2 specs a `record_index` table (a one-directional, disposable FTS5 projection of the `Y.Doc`, meant to back `query_collection`/`search_workspace`) — it is **not built yet**; both of those currently read the `Y.Doc` directly instead (verified against `src/lib/server/db/schema.ts`, which defines only the three tables above). The Table view's live grid was always meant to read directly off Yjs observers regardless, not this table.
- **Routes** (`architecture.md` §2): `/` workspace home, `/doc/[id]` Document view (block editor + toolbar + slash menu), `/table/[id]` Collection/Table view, `/settings/tokens` token management, `/mcp` the MCP HTTP endpoint. `src/lib/client/yjs-client.ts` wraps the y-websocket connection and is the single data-access layer shared by UI code and (server-side) MCP code — don't duplicate its read/write functions.
- **Workspace/shard resolution** (`architecture.md` §1, issue #30): there is no process-global `Y.Doc`/Awareness getter — every boundary (the `/ws` handler, each `services/*.ts` function, the read-only route loads) calls `resolveWorkspaceContext()` (`src/lib/server/workspace-store.ts`) to get `{doc, awareness, connections}` back. The registry genuinely supports more than one `{workspaceId, shardId}` key (proven in `workspace-store.test.ts`), but Phase 0 has no auth to pick a different one, so every current call site resolves with no selector and always gets the same default context — a client-supplied value (e.g. the WS room path segment) is accepted as a forward-compatible selector but is **never** treated as authority yet. Don't reintroduce a bare singleton getter for this; #13/#6 build directly on this seam.
- **Dev server plumbing**: `vite.config.ts` attaches the `/ws` Yjs endpoint to Vite's own HTTP server via `server.ssrLoadModule` (not a plain top-level `import`) specifically so the dev server's WebSocket layer shares the _same_ workspace-store registry as the rest of the SSR module graph — a plain import would silently create a second, disconnected `Y.Doc`. Don't "simplify" that import.

## Testing model (why there are two E2E tiers)

Unit tests calling `records.ts`/`services/*.ts` directly, and manual/Playwright-only UI testing, both structurally miss bugs at the MCP↔Yjs transport boundary (a real bug of this shape already happened: a token's document grant was correct in-memory for one MCP call and gone on the next). Per `e2e-testing.md`:

- **Tier A** (`tests/e2e/tier-a.test.ts`, vitest): boots the real server and opens two _independent_ real clients — an actual `@modelcontextprotocol/sdk` `Client` over HTTP, and a real `y-websocket` client — asserting convergence between them. Tests do import internal modules directly for setup and assertions (e.g. `createDocument`, `getRecordYText`, `queryAuditLog`); what makes a test Tier A is that the actual read/write being verified goes through the two real client protocols, not that internal modules are off-limits. Write a Tier A test for anything permission-, grant-, hold-, or attribution-related.
- **Tier B** (`tests/e2e/tier-b.spec.ts`, Playwright): real browser, but the triggering action still comes from a real MCP client call in the test's Node context. Reserved for behavior that specifically needs a rendered DOM (held-block shimmer, live sidebar tree updates) — keep this tier small.
- Shared harness: `tests/e2e/harness.ts` (the only place that should know how to boot a full server instance for tests).
- Vitest is split into three projects (`vite.config.ts`): `server` (node env, most of `src/**` + `tests/**`), `client` (jsdom, `src/lib/client/**`), `component` (jsdom + `browser` resolve condition, `src/**/*.svelte.test.ts` — needed because Vitest's default SSR condition resolves `svelte` to a build without `mount()`).
