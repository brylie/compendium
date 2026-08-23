# Specifications

Canonical specification for each implemented subsystem, translating [`agent-workspace-prd.md`](../agent-workspace-prd.md) into concrete engineering decisions. Split by feature rather than kept as one document, so a change to one subsystem doesn't require editing (or risk going stale in) an unrelated one.

- [`architecture.md`](./architecture.md) — process model (one Node process, `/ws` + `/mcp`) and SvelteKit app structure.
- [`data-model.md`](./data-model.md) — the Record/Document/Collection types and their Yjs mapping.
- [`collaboration.md`](./collaboration.md) — presence and holds, built on Yjs Awareness.
- [`mcp-tools.md`](./mcp-tools.md) — the MCP tool surface and permission scoping.
- [`markdown-transcoding.md`](./markdown-transcoding.md) — the `Y.Text` ⇄ Markdown boundary.
- [`persistence.md`](./persistence.md) — SQLite via Drizzle: snapshots, audit log, access tokens, and the query read model.
- [`service-layer.md`](./service-layer.md) / [`service-layer-manifest.md`](./service-layer-manifest.md) — how permission/audit logic is centralized once and shared by MCP and UI.
- [`e2e-testing.md`](./e2e-testing.md) — the MCP/UI parity testing strategy.
- [`design-system.md`](./design-system.md) — UI tokens and conventions.

## Out of scope for the current architecture

Multi-user auth, workspace admin, per-user OAuth, and hybrid search are explicitly not covered by these specs — the architecture above is single-tenant, local-trust, no login. They are tracked on the [canonical GitHub Project roadmap](https://github.com/users/brylie/projects/6), rather than speculatively specified here. Each gets its own technical-design pass under `docs/specifications/` once actually prioritized, rather than being guessed at in advance.

When hybrid search is prioritized, its starting point is a disposable Postgres projection of the Y.Doc, combining full-text search and pgvector semantic search with a fusion ranking strategy such as reciprocal-rank fusion. The embedding provider remains a deliberate privacy decision: hosted embeddings send workspace content to a third party, while a local model trades operational simplicity for data locality.
