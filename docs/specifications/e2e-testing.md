# Specification — End-to-End Testing (MCP/UI parity)

**Status:** Draft
**Depends on:** [`architecture.md`](./architecture.md) §1 (process architecture), [`collaboration.md`](./collaboration.md) (holds/Awareness), [`mcp-tools.md`](./mcp-tools.md) (MCP tool surface); [`prd.md`](../prd.md)'s acceptance criteria under "Real-time collaborative editing," "Agent read/write API," and "In-progress agent edit indicator" — the tests specified here exist to actually verify those criteria, most of which are not currently exercised by any test.
**Motivated by:** a live Phase 1 review that found a bug (MCP `create_document` granting itself access in a way that never persists — see [`service-layer.md`](./service-layer.md) §1) invisible to both the existing unit test suite and to manual UI testing, because it only manifests across two independent calls crossing the actual MCP transport boundary.

---

## 1. Why unit tests and UI tests both miss this class of bug

The PRD's central bet is that MCP writes and UI writes go through the _same_ sync engine and are indistinguishable in effect (`prd.md`, Goal 1 and the "Real-time collaborative editing" acceptance criteria). The failure mode that actually threatens that bet isn't in the CRDT logic — Yjs is well-tested upstream, and `records.ts`'s unit tests already cover it adequately. It's in the **glue around the CRDT**: does a permission grant made by one MCP call actually survive to the next MCP call? Does a write made by one client (MCP or browser) actually reach the other within the latency bound the PRD promises?

- **Unit tests** (calling `records.ts` or a future `services/*.ts` function directly, in-process) never cross the MCP HTTP transport or the y-websocket transport at all — they can't see a bug where the _transport boundary itself_ is where state gets dropped (exactly what happened with the token grant: correct in memory for the duration of one call, gone the moment a fresh `verifyToken()` runs on the next).
- **UI-only testing** (manual or Playwright driving only the browser) never issues an MCP call, so it can't see agent-side breakage at all — and it's exactly agent-side writes, not human-side ones, that the PRD singles out as the differentiator ("an AI app writes an edit... the web UI reflects it... with no manual refresh").

The fix: tests that hold open two _independent, real_ client connections — one MCP, one Yjs/websocket — against one real running server process, and assert convergence between them. That is the only shape of test that can catch a transport-boundary bug.

## 2. Two tiers

### Tier A — protocol-level parity tests (primary; write these first)

**What they are:** Vitest tests that boot the actual server (real `Y.Doc`, real SQLite — a temp file or `:memory:`, an ephemeral port), then open two real clients against it:

- an **MCP client** — the official `@modelcontextprotocol/sdk` `Client`, using its HTTP transport, authenticated with a real bearer token issued through the same `createToken()` path production uses.
- a **Yjs client** — a real `y-websocket` connection (or the same client wrapper the browser UI uses, `lib/client/yjs-client.ts`), connected to `/ws`, standing in for a browser tab.

Tests do import internal modules directly — `records.ts`, a `services/*.ts` function, or another `$lib` module — for setup and assertions (e.g. seeding a document with `createDocument`, or reading back state with `getRecordYText`/`queryAuditLog`). What makes a test Tier A isn't that internal modules are off-limits; it's that the actual mutation and observation being verified goes through the two real client protocols (the MCP `Client` and the `y-websocket` client), not a direct in-process call standing in for either. This is what makes the tier catch transport-boundary bugs instead of just re-testing the CRDT.

**Test shape — the general pattern:**

```text
1. Start server, get a fresh SQLite path + free port.
2. Create an access token via the real token-creation path.
3. Open an MCP Client (transport → this server, this token).
4. Open a Yjs client (websocket → this server's /ws).
5. Perform an action via one client.
6. Assert the OTHER client observes the resulting state — polling/waiting up
   to the PRD's latency bound, not asserting instantly (sync is async).
7. For anything permission- or grant-related: make a SECOND, INDEPENDENT MCP
   tool call (same token, fresh call — not reusing any object from step 5)
   and assert it sees the correct, persisted state. This is the step that
   would have caught the create_document self-grant bug.
```

**Required test list** (each maps to a specific PRD acceptance criterion):

| Test                                                                                                                                                                                                                                                       | PRD criterion it verifies                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP `write_record` → Yjs client observes new content within latency bound                                                                                                                                                                                  | "when that AI app writes an edit, then the web UI reflects it within the same latency bound as a native co-editor's change"                                                                                                                                                                                                                                                                                                                                         |
| Yjs client write → a second, independent MCP `get_document` call observes it                                                                                                                                                                               | Same criterion, opposite direction — MCP is a first-class reader too                                                                                                                                                                                                                                                                                                                                                                                                |
| MCP `create_document` (nested) → a **second, independent** MCP call (`get_document` or `write_record`) on the new document succeeds                                                                                                                        | Directly regression-tests the self-grant bug; this is the test called out in `service-layer.md` §1                                                                                                                                                                                                                                                                                                                                                                  |
| MCP `hold_records` on a block a human's cursor is in → denied for that block, granted for the rest of the requested set                                                                                                                                    | "Given a human's cursor is in a block, when an agent requests a hold on a set that includes that block, then that block is denied... while the agent's holds on the rest of the set succeed"                                                                                                                                                                                                                                                                        |
| MCP holds a block, Yjs client (human) starts editing it → hold releases, human's edit is not overwritten by the agent's in-flight write                                                                                                                    | "the hold is released and the human's edit is not overwritten by the agent's in-flight write"                                                                                                                                                                                                                                                                                                                                                                       |
| MCP holds a block, connection is dropped without writing, TTL elapses → block reverts to prior content                                                                                                                                                     | "the block reverts to its pre-hold content automatically, with no manual cleanup required"                                                                                                                                                                                                                                                                                                                                                                          |
| Token scoped to one document → MCP calls against any other document return permission-denied                                                                                                                                                               | "An agent or client granted access to a single document cannot read or write any other document"                                                                                                                                                                                                                                                                                                                                                                    |
| Every MCP write/delete call → a corresponding audit log entry exists, correctly attributed                                                                                                                                                                 | Audit log acceptance criterion                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A Yjs client write (the actual browser-UI persistence path — e.g. the `+page.svelte` block editor calling `$lib/data/records.ts` directly, not an MCP call standing in for it) → a corresponding audit log entry exists with the correct actor attribution | Audit log acceptance criterion, UI-originated side — **currently unmet**: the UI's block create/write/delete path calls `$lib/data/records.ts` directly rather than going through `src/lib/services/*.ts`, so no `logAudit` call exists on that path today (only Document-level actions routed through `+page.server.ts`/`api/*/+server.ts` are audited). This test is expected to fail until that gap is closed, tracked as follow-up work rather than fixed here. |
| MCP `move_document` (once built, per the fix list) → both the mover's own subsequent read and a differently-scoped token's read reflect the correct new permission boundary                                                                                | Same category as the create_document case — any operation that changes what a token can reach needs this shape of test                                                                                                                                                                                                                                                                                                                                              |

### Tier B — browser-visible behavior (secondary; smaller set)

**What they are:** Playwright tests, but driven the same way — a real browser session against the real server, with the _triggering_ action coming from a real MCP client call made from the test's Node context (not simulated in the browser). These exist only for behaviors that are genuinely about rendering, which Tier A can't see because it never opens a DOM:

- The held-block placeholder (shimmer + agent avatar) appears when an MCP `hold_records` call holds a block currently visible in an open browser tab, and disappears with the correct atomic content swap when the agent writes.
- The sidebar tree updates live (new node appears, correctly nested) when a document is created via MCP `create_document`, with no manual refresh.
- The "this block is being generated" indicator is visually distinct from a real typing cursor (a visual-regression or DOM-attribute check, not a pixel-perfect requirement).

Keep this tier small and targeted — anything that doesn't specifically need a rendered DOM to verify belongs in Tier A instead, where it's faster and more reliable.

## 3. Test harness

A shared fixture module, `tests/e2e/harness.ts`, used by both tiers:

- Starts the server (reusing `server.ts`'s entry point, or a test-mode equivalent) on an ephemeral port, pointed at a temp SQLite file that's deleted on teardown.
- Exposes `createTestToken(opts)` → wraps the real `createToken()` path.
- Exposes `getMcpClient(token)` → a connected, authenticated MCP SDK `Client` against this server instance.
- Exposes `getYjsClient()` → a connected `y-websocket`/`lib/client/yjs-client.ts` instance against this server's `/ws`.
- Exposes a `waitForCondition(fn, { timeoutMs })` poller for the "assert convergence within the latency bound" pattern in §2, rather than each test hand-rolling a retry loop.

This harness is the only thing that should know how to boot a full server instance for tests — individual test files should never construct their own ad hoc server setup, to keep the tiering (and the "no internal shortcuts" rule from §2) consistent across the suite.

## 4. Tooling and CI placement

- **Tier A** uses Vitest (already the project's test runner — no new dependency for the runner itself; the MCP SDK client and a Yjs client are both already project dependencies via the server-side code). Fast enough (no browser) to run in the normal `npm run test` suite and in CI on every PR.
- **Tier B** uses Playwright (new dev dependency). Slower and more flake-prone than Tier A by nature of driving a real browser — run it in CI on every PR too, but keep the tier small (per §2) precisely so this cost stays bounded rather than growing into a full UI-test suite; the PRD's UI is already covered qualitatively by manual dogfooding per the Phase 0/1 success-metrics framing (`prd.md`, "Success Metrics").

## 5. Relationship to existing and future unit tests

This spec doesn't replace `records.ts`'s existing unit tests, or the equivalent tests the service layer (`service-layer.md`) will need — those stay valuable for fast, fine-grained coverage of CRDT and business-rule logic. Tier A is specifically for the narrower, higher-value class of bug that only exists at the transport boundary between two independent real clients — write a Tier A test whenever a change touches anything permission-, grant-, hold-, or attribution-related, since those are exactly the categories where "worked in the unit test, broke for a real second agent call" has already happened once.

## 6. Capacity benchmark — CRDT and sharding regression gate

Tier A proves that a small number of real clients converge correctly. It does
not establish that the shared state stays within a workable resource envelope
as documents, Collections, concurrent clients, and MCP activity grow. The
capacity benchmark fills that gap while preserving the same real server, Yjs
WebSocket, MCP HTTP, and temporary SQLite boundaries.

### Profiles and commands

```sh
npm run benchmark:workspace        # `daily`: bounded profile, suitable for CI
npm run benchmark:workspace:large  # `large`: manual pre/post-change comparison
```

The benchmark lives in `tests/benchmark/workspace-capacity.test.ts` and runs
in its own Vitest project. It is intentionally excluded from `npm run test`
and coverage: performance work must stay discoverable and repeatable without
making ordinary correctness checks slow or environment-sensitive. Every run
creates a temporary SQLite database and random local port; it must never point
at a developer's running workspace database.

`daily` uses a small knowledgebase fixture and carries conservative CI
guardrails. `large` is deliberately not a CI gate: use it before and after a
change where state topology or transport cost could change, then publish the
two results with the environment and fixture in a dated note under
`docs/benchmarks/`.

### When an engineer or agent must run it

Run the bounded profile for a PR that changes any of the following:

- the Yjs record schema, encoded representation, or document/Collection
  ownership model;
- `attach-ws.ts`, WebSocket connection lifecycle, routing, or update fan-out;
- `workspace-store.ts`, shard selection, context lifecycle, or snapshot load/
  flush behavior;
- MCP write paths that change edit churn, cross-client update application, or
  persistence behavior.

Run both profiles for shard-aware routing, catalog/SSE integration, compaction,
snapshot-format, or persistence redesign. For the workspace-catalog work,
this is a required before-and-after acceptance check, not an optional
optimization exercise.

### How to interpret and maintain results

The suite records encoded state/snapshot size, client-visible initial-sync and
fan-out bytes, convergence and MCP-write timing, restart time, and Node host
resource signals. Initial-sync measurements must have `disableBc: true` for
every benchmark provider, including the seed client: otherwise same-process
BroadcastChannel sharing bypasses WebSocket traffic and makes the transport
envelope appear smaller than it is.

Use the current [CRDT capacity baseline](../benchmarks/crdt-capacity-baseline-2026-08-30.md)
as the decision record. Compare like-for-like results rather than treating
machine-specific timings as universal SLOs. A daily-profile guardrail failure,
a global snapshot of 2 MiB or more, or event-loop p99 of 100 ms or more is a
sharding/compaction escalation: document it and link the related issue or PR.
When an intentional fixture or architecture change makes a new baseline valid,
write a new dated note; do not silently overwrite an old decision record.
