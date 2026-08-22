# Phase 1 Notes

Follow-up questions and decisions that come up while Phase 0 is being built, kept separate so the Phase 0 docs (agent-workspace-prd.md, technical-design.md, phase-0-build-plan.md) stay stable for whatever's actively reading them. Not a spec yet — a running log to turn into a real Phase 1 technical design once Phase 0 is far enough along to revisit.

---

## Content retrieval: hybrid search (plain-text + vector), on Postgres

**Context:** Phase 0's `technical-design.md` §7.5 uses a plain SQLite table + FTS5 for `query_collection`/`search_workspace` — deliberately minimal, matching Phase 0's one-shot-query framing. For Phase 1, moving to Postgres (as you're leaning toward) opens up pgvector for semantic search alongside plain-text.

**Should it be plain-text or vector search?** Both, not either — this is the standard "hybrid search" pattern now, and it fits this product well specifically: `search_workspace` is mostly called *by agents*, and agent queries tend to be natural-language ("find notes about the Q3 plan") rather than exact keyword matches. Plain-text search (fast, deterministic, zero extra infrastructure) misses paraphrases; vector search catches those but is weaker on exact terms, IDs, or code identifiers. Combining both and merging results (e.g., reciprocal rank fusion) is the idiomatic answer, not a single-method choice.

**Drizzle + Postgres fit, confirmed rather than assumed:** Drizzle ORM added first-class pgvector support in 0.36+ — a native `vector` column type and a `cosineDistance` operator, with an official guide (["Vector similarity search with pgvector"](https://orm.drizzle.team/docs/guides/vector-similarity-search)). Postgres full-text search is also supported, though `tsvector` isn't a native Drizzle column type — the documented pattern is a **generated column** (Postgres computes the `tsvector` from source text automatically, Drizzle just declares and indexes it) per Drizzle's [own full-text-search guide](https://orm.drizzle.team/docs/guides/full-text-search-with-generated-columns). Both are genuinely idiomatic in the Drizzle ecosystem, not bolted on. Reported performance: pgvector 0.7 with an HNSW index gets sub-50ms top-K retrieval even on a free Neon tier — comfortably fine at personal-workspace scale.

**Shape of the design (sketch, not finalized):**
- Same one-directional sync pattern as Phase 0's `record_index` (§7.5): whenever a `Y.Doc` record changes, re-derive both its `tsvector` (automatic, via the generated column) and its embedding, upsert into Postgres. `Y.Doc` stays the sole source of truth; this table is still a disposable, rebuildable projection.
- `search_workspace` runs both a full-text query and a vector similarity query, merges/ranks the two result sets, returns one list.
- **Open, not yet decided:** where embeddings come from. A hosted API (Voyage AI, OpenAI, etc.) is simplest but sends personal-workspace content to a third party on every edit — worth weighing against a local embedding model (e.g., via a local runtime) given this is explicitly a personal knowledgebase and privacy may matter more here than it would for a team product. Not resolved — flagging it now so it isn't decided by default later.

**Also open:** you mentioned needing to figure out why Docker is crashing — separate from this, but worth noting if Postgres-for-Phase-1 ends up running locally via Docker too, that's now two things depending on Docker Desktop being healthy (Postgres, and whatever the original AFFiNE trial needed it for). Worth resolving that independently of which database Phase 1 lands on.
