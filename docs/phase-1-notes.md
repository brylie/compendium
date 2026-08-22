# Phase 1 Notes

Follow-up questions and decisions that come up while Phase 0 is being built, kept separate so the Phase 0 docs (agent-workspace-prd.md, technical-design.md, phase-0-build-plan.md) stay stable for whatever's actively reading them. Not a spec yet — a running log to turn into a real Phase 1 technical design once Phase 0 is far enough along to revisit.

---

## Content retrieval: hybrid search (plain-text + vector), on Postgres

**Context:** Phase 0's `technical-design.md` §7.5 uses a plain SQLite table + FTS5 for `query_collection`/`search_workspace` — deliberately minimal, matching Phase 0's one-shot-query framing. For Phase 1, moving to Postgres (as you're leaning toward) opens up pgvector for semantic search alongside plain-text.

**Should it be plain-text or vector search?** Both, not either — this is the standard "hybrid search" pattern now, and it fits this product well specifically: `search_workspace` is mostly called _by agents_, and agent queries tend to be natural-language ("find notes about the Q3 plan") rather than exact keyword matches. Plain-text search (fast, deterministic, zero extra infrastructure) misses paraphrases; vector search catches those but is weaker on exact terms, IDs, or code identifiers. Combining both and merging results (e.g., reciprocal rank fusion) is the idiomatic answer, not a single-method choice.

**Drizzle + Postgres fit, confirmed rather than assumed:** Drizzle ORM added first-class pgvector support in 0.36+ — a native `vector` column type and a `cosineDistance` operator, with an official guide (["Vector similarity search with pgvector"](https://orm.drizzle.team/docs/guides/vector-similarity-search)). Postgres full-text search is also supported, though `tsvector` isn't a native Drizzle column type — the documented pattern is a **generated column** (Postgres computes the `tsvector` from source text automatically, Drizzle just declares and indexes it) per Drizzle's [own full-text-search guide](https://orm.drizzle.team/docs/guides/full-text-search-with-generated-columns). Both are genuinely idiomatic in the Drizzle ecosystem, not bolted on. Reported performance: pgvector 0.7 with an HNSW index gets sub-50ms top-K retrieval even on a free Neon tier — comfortably fine at personal-workspace scale.

**Shape of the design (sketch, not finalized):**

- Same one-directional sync pattern as Phase 0's `record_index` (§7.5): whenever a `Y.Doc` record changes, re-derive both its `tsvector` (automatic, via the generated column) and its embedding, upsert into Postgres. `Y.Doc` stays the sole source of truth; this table is still a disposable, rebuildable projection.
- `search_workspace` runs both a full-text query and a vector similarity query, merges/ranks the two result sets, returns one list.
- **Open, not yet decided:** where embeddings come from. A hosted API (Voyage AI, OpenAI, etc.) is simplest but sends personal-workspace content to a third party on every edit — worth weighing against a local embedding model (e.g., via a local runtime) given this is explicitly a personal knowledgebase and privacy may matter more here than it would for a team product. Not resolved — flagging it now so it isn't decided by default later.

---

## Block types beyond Document + Table

**Framing:** the target is local documentation and personal project organization — not public blog posts, marketing pages, or a website. That's the filter for everything below, and it rules out a lot of what Notion and Gutenberg both ship. It also means checking a claim before building on it: the "500 block types" figure floating around for Notion doesn't match Notion's own public API, which only exposes ~29 named block types (the list already collected above — `paragraph`, `heading_1`–`4`, `callout`, `toggle`, `synced_block`, `bookmark`, `embed`, etc.). The 500 almost certainly counts _embeddable external services_ (YouTube, Figma, Spotify, ...), which Notion handles through a small number of generic embed/bookmark block types plus URL-unfurling logic — not through 500 distinct block types. That distinction directly shapes the recommendation below: build a handful of well-chosen block types, not one per integration.

**Architecture check first:** per the PRD's core bet, adding a new block type should mean "new `blockType` string + a renderer + a slash-command entry + Markdown transcoding rules for it" — no changes to CRDT, hold/placeholder, permissions, or the MCP tool surface, since those all operate on `Record` generically regardless of `blockType`. That holds for every _text-based_ block below. It does **not** fully hold for image/file/video/audio/pdf — those need an asset storage layer Phase 0 doesn't have yet (binary content has to live somewhere and be referenced by a stable URL/path), which is a real new piece of infrastructure, not just a new block type. Worth being honest about that cost rather than lumping media in with the cheap text blocks.

**Recommended core set for Phase 1** (all cheap, text-based, no new infrastructure):

- `heading_1`–`heading_4` (matching Notion's depth, not Gutenberg's H6 — docs rarely need 6 levels; H4 is already generous for a personal knowledgebase)
- `bulleted_list_item`, `numbered_list_item`, `to_do` — the checkbox item ties directly into the existing `checkbox` property type and directly serves the "stay organized" goal, not just a text-formatting nicety
- `quote`, `divider`
- `callout` — genuinely high-value for technical documentation (Note/Warning-style highlighted boxes); worth prioritizing over several Notion blocks that rank higher in its own UI but matter less here
- `toggle` — collapsible section; valuable for long docs where detail should default to collapsed
- `code` — with syntax highlighting; not optional, given the stated volume of technical documentation
- `table_of_contents` — architecturally different from the rest: it's a **computed/live block**, not stored content. It reads the current Document's own heading blocks at render time rather than owning `Y.Text` — closer to a tiny View than a content block. Worth designing as such rather than forcing it into the same shape as `paragraph`.

**Worth adding, one architecturally interesting case:**

- `synced_block` (Notion's term) — a block that _references_ another record's content rather than owning its own. This maps directly onto the existing model: every record already has a stable global ID, so a synced block is just `{blockType: 'reference', referencedRecordId}`, rendering that record's actual `Y.Text` wherever it's placed. Editing it anywhere edits the one underlying record. The one real subtlety: holding a synced-block instance needs to hold the _referenced_ record, not a separate copy, or two "copies" could independently claim a hold on what's actually the same content. Worth flagging now, cheap to get right from the start, expensive to retrofit — same pattern as other architecture decisions in this project.
- Generic `bookmark`/`embed` (a single block type that unfurls title/description/favicon from a URL) instead of building per-service blocks. Covers the same breadth Notion's "500 services" claim implies, through one mechanism instead of dozens of bespoke integrations — directly informed by the correction above.

**Explicitly excluded, and why** (all fail the "local documentation, not public content" filter):

- Notion's **AI blocks** — this product's AI surface is MCP-driven agent read/write (see the PRD's whole thesis), not an in-editor AI-writing block. Adding one would duplicate the PRD's existing non-goal against building a competing chat interface.
- Gutenberg's **Theme blocks** (Site Title, Site Logo, Navigation, Query Loop, Post-*, Pagination) — website/full-site-editing primitives, orthogonal to a personal docs tool.
- Gutenberg's **Widget blocks** (Archives, Calendar widget, Categories List, RSS, Search widget, Shortcode, Social Icons, Tag Cloud) — same reasoning, website-oriented.
- **Per-service embed blocks** (dedicated X/Twitter, Instagram, TikTok, Pinterest, Facebook blocks) — covered by the generic embed/bookmark block instead; social embeds specifically are low-relevance for local documentation regardless.
- **Template buttons** — interesting, but really a workflow-automation feature (insert a predefined block structure), adjacent to the already-deferred P2 workflow automation item rather than a basic content block. Revisit alongside that, not before.
- **Breadcrumb** — better as persistent page-header UI chrome (always show the Document's path) than something a user manually inserts as a block.
- **`transcription`/`unsupported`** — Notion-specific internal/edge-case types with no equivalent need here.

**Lower priority within Phase 1, but not blocking:** `equation` (LaTeX; niche, cheap once the renderer exists, no urgency), `column`/`column_list` (real editor complexity for modest documentation value — rank below callout/toggle/code).

**Deferred to Phase 3+, not Phase 1:** `image`, `file`/`pdf`, `video`, `audio`. These are the ones that actually need the asset-storage layer called out above — real new infrastructure (where binary content lives, how it's referenced, backup/sync implications), not a cheap `blockType` addition like the rest of this list. Pushing them to Phase 3 (PRD's "Scale, automation, and ecosystem" phase) rather than treating them as a Phase 1 nice-to-have keeps Phase 1 to genuinely cheap additions only. Worth revisiting sooner if Phase 0/1 dogfooding surfaces a concrete need (e.g., wanting to drop a screenshot into a doc) rather than deferring on principle alone.

**Not decided, worth a deliberate call before building `child_page`:** is a sub-page a block type that references another top-level Document (a `page-link` block pointing at a Document ID, keeping every Document a first-class top-level record with its own `recordIds`), or does the model need actual nesting of Documents inside Documents? The former fits the existing architecture cleanly with zero new concepts; the latter would be a real change. Recommend the former, but flagging it as a decision rather than assuming it's obvious.
