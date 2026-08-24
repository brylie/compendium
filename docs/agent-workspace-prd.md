# Agent-First Workspace — Product Requirements Document

_Working title: "the Workspace." Naming TBD — not a v1 blocker._

**Status:** Draft for review
**Owner:** Brylie Christopher Oxley
**Last updated:** 2026-08-22
**Licensing intent:** if the personal MVP (Phase 0) proves out, the plan is to open-source it — Apache 2.0 preferred over AGPL. This is a real constraint on dependency choice from here forward, not a someday detail (see Prior Art and technology candidates below).

---

## Problem Statement

Knowledge work is increasingly performed jointly by humans and AI agents, but the tools teams use to hold that knowledge — Notion, Confluence, Google Docs — were built for humans only. Agents get bolted on as a chat sidebar or a one-shot "generate this page" button; they cannot reliably read the rest of the workspace, hold a durable identity, or write back into a document the way a human collaborator does. Teams that have adopted agents for research, drafting, and status-keeping end up pasting agent output between chat windows and documents by hand, which breaks the audit trail, duplicates work, and lets the document silently drift out of sync with what the agent actually did or knows.

This is a growing cost for exactly the teams most invested in agentic workflows: the more an organization relies on agents, the more time it loses to this copy-paste seam, and the more its "source of truth" documents become stale relative to what its agents have already learned or produced.

A related, compounding cost is tool fragmentation: teams keep documentation in one tool, tasks in a kanban board, structured data in a spreadsheet, and schedules in a calendar — each with its own data model, so neither humans nor agents can treat "what the team knows" as one queryable thing. Every hand-off between those tools is another place work goes stale, gets duplicated, or falls out of an agent's reach entirely.

Real-time coordination between humans and agents is comparatively well solved already — tools like Buzz (buzz.xyz) show that human+agent chat, with agents as first-class participants, works today. What's still missing, based on direct hands-on use of that kind of tool, is the _content_ layer: chat is where a team talks about the work, but the documents, tables, and structured records those conversations are about still live outside any shared, real-time, agent-writable workspace. This project is deliberately scoped to that specific gap — collaborative, CRDT-backed content — not to rebuilding chat.

**Competitive context, checked rather than assumed:** repeated first-hand frustration is the actual origin of this thesis — pasting Copilot output into Confluence by hand, Claude regenerating a whole new Google Drive document instead of editing the one already open (then manually deleting the old copy), hand-copying Markdown into Google Docs. Checking this rather than just asserting it turned up a real correction: as of Google's own April 2026 product update, Gemini does now edit Google Docs in place, and Copilot edits Word in place too — each within its own vendor's walled garden. But the sharper claim holds, and it's vendor-confirmed, not just observed: per Microsoft's own description, an assistant reaching into a file format _outside its home ecosystem_ "creates a new file instead of updating" it. That's exactly what all three frustrations above are instances of — the gap isn't "in-place agent editing is impossible," it's "in-place agent editing is walled to your own vendor's ecosystem." That's a better thesis for this project than the original, broader one: an MCP-based workspace is vendor-agnostic by construction, so any MCP-compatible agent — regardless of which company built it — gets the same in-place record access, because the workspace itself, not any one vendor's document format, is the shared surface. Validated by repeated direct use across three ecosystems; no formal multi-user market discovery is planned as a gate before Phase 1 — this isn't the kind of claim more interviews would sharpen further, given the vendors' own admissions already confirm the mechanism.

## Goals

1. **Agent parity, including bring-your-own AI clients** — a workspace-hosted agent, or a user's own external AI app (Claude Desktop, ChatGPT, Gemini, connected via MCP), can read and write content with the same fidelity, structure, real-time sync, and audit trail as a human editing in the native UI. Access modality (web UI vs. an external MCP client) is a client choice, not a different tier of integration.
2. **Real-time collaborative editing** — humans and agents can co-edit the same document concurrently, with visible attribution per change and automatic conflict resolution, at the standard users expect from Notion/Google Docs today.
3. **Unified, agent-native data model** — documentation, tables/databases, kanban boards, and calendars are _views_ over one underlying record model, exposed through a single structured protocol (MCP), so agents and the UI address content the same way regardless of which modality a human currently has it rendered as. New modalities in the future are new views, not new subsystems.
4. **Retention as a real workspace** — teams keep using it as their primary knowledge base after the novelty wears off, not just as an agent demo, measured by weekly-active-workspace retention at parity with human-only collaboration tools.

_Workflow automation (documents that trigger an agent on a schedule or a change) is a genuinely strong future direction, but is deliberately not an MVP goal — see Future Considerations below. Pulling it out of the goal list keeps v1 focused on proving collaborative editing and agent parity before adding automation on top of them._

## Non-Goals

1. **Not a general agent orchestration platform.** We integrate with existing agent runtimes (Claude Agent SDK, MCP-compatible agents) rather than building our own agent execution engine. Reinventing agent orchestration would dilute focus from the workspace/collaboration problem we're uniquely positioned to solve.
2. **Not deep project-management features.** No Gantt charts, resource/capacity planning, sprint velocity, or dependency graphs. Kanban and calendar are _view types_ over the unified record model (P1) — cheap once the model exists — but we are not building PM-suite depth on top of them.
3. **Not offline-first.** Real-time multi-agent collaboration requires a live connection to resolve concurrent edits; local-only editing is out of scope until the collaboration core is proven.
4. **Not a proprietary model, and not a competing chat interface.** Agent capability is provided by pluggable model providers (starting with Claude); we are not training our own LLM or building a full chat assistant UI to rival Claude Desktop/ChatGPT/Gemini. Any lightweight in-app agent trigger (e.g., @-mentioning a Team agent) is a convenience, not a substitute for the deeper interaction users already have in their own AI apps — which is exactly what the MCP connection is for.
5. **Not chat/discussion channels, in any phase, absent strong new evidence.** This is a deliberate non-goal, not just a deferral. Real-time human+agent chat is already well solved by tools like Buzz (buzz.xyz) — validated through direct hands-on use where chat and agent collaboration worked well, and the actual gap was that shared documents lived outside that workspace. Rebuilding chat would compete with tools that already do it well instead of shipping the thing that's actually missing. If coordination with a chat tool is ever needed, the path is integration (an agent operating inside Buzz connecting to this workspace over the same MCP surface as any other external agent — see Requirements) rather than building channels natively.
6. **Not enterprise-certified in v1.** No SOC 2, HIPAA, or SSO/SCIM in this phase. Enterprise compliance is a distinct future phase once product-market fit is established.
7. **Not multi-user authentication in the initial personal build.** Phase 0 runs single-tenant, trusted-local, for one person — no login/authorization system needed yet, since there's no second person to authenticate against. Auth is added deliberately in Phase 1, triggered by the actual need to share the tool, not built speculatively ahead of it.

## Target Users

**The first real user is single-player.** This gets built to solve the founder's own problem first — staying organized across several concurrent projects, today, as one person on one laptop — not to satisfy a team market thesis from day one. That reorders what "v1" has to mean: a personal, single-tenant build proves out collaborative CRDT content and agent parity before any multi-human permission, auth, or admin apparatus exists at all. Team and admin features get added deliberately once the tool is proven personally and shared outward to friends or collaborators — not built speculatively ahead of that need. See Timeline Considerations for how this reshapes phasing (a new Phase 0 ahead of everything below).

**Eventual market wedge, once expansion happens: AI-native team operators** — technical and product teams of roughly 2–30 people who already run AI agents as part of their daily workflow (engineering, product, ops) and are currently stitching agent output into their docs by hand. This is the sharpest _market_ wedge because:

- They feel the copy-paste seam acutely and today, so the value proposition doesn't require behavior change — it removes a step they already resent.
- They're comfortable granting an agent scoped write access, unlike more risk-averse enterprise buyers.
- They're a plausible design-partner population for the multi-agent and MCP-facing requirements below.

Personas used throughout this spec (in Phase 0, Team member and Workspace admin are the same one person — the roles already exist in the model so nothing has to be rebuilt later, but only one of them is actually exercised until a second person joins in Phase 1):

| Persona                      | Description                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Team member**              | Human editor who writes and edits documents, and delegates sub-tasks to agents inline.                                                                                                                                                                                                                                   |
| **Team agent**               | A persistent, workspace-scoped agent with a name and role (e.g., "Research Agent," "Status Bot") and permissions like a team member. Its identity belongs to the workspace, not to any one person.                                                                                                                       |
| **Personal AI client (BYO)** | The _same team member's_ own external AI subscription app — Claude Desktop, ChatGPT, Gemini — connected via MCP under that person's own account. Not a separate identity: it's an alternate access modality for a human who already has a seat, alongside the web UI.                                                    |
| **Workspace admin**          | Manages membership, permissions, and which agents/integrations can access the workspace.                                                                                                                                                                                                                                 |
| **External agent**           | A third-party developer's custom-built agent connecting via the MCP-facing API with scoped, revocable access, independent of any specific team member. Includes an agent operating inside a separate chat/coordination tool (e.g., Buzz) that connects here to read/write records — no separate integration path needed. |

## User Stories

### Team member

- As a team member, I want to co-edit a document with a teammate in real time so that we can draft together without version conflicts.
- As a team member, I want to @-mention a team agent inline in a document so that it can act on that section without me leaving the page.
- As a team member, I want to see exactly which edits were made by which agent, with a timestamp, so that I can trust and audit what changed while I was away.
- As a team member, I want to revert an agent's edit with one action so that a bad or unwanted change doesn't require manual cleanup.
- As a team member, I want to see a clear "this block is being generated" indicator — not a fake typing cursor — while an agent edits so that I understand a block is mid-change and don't confuse it with a human actively typing.
- As a team member, I want to keep a set of structured records (e.g., project tasks) in a Table alongside my written docs, in the same workspace, so that I don't have to export/import between a docs tool and a separate database tool.

### Personal AI client (BYO — Claude Desktop, ChatGPT, Gemini, etc.)

- As a team member, I want to connect my own AI subscription app to the workspace via MCP, under my own account, so that I can use the assistant I already pay for and know how to work with, instead of a bundled in-app one.
- As a team member, when I ask my connected AI app to edit a document, I want that edit to appear live in the workspace UI — the same way a co-editor's change would — so a teammate watching the document on another screen sees it happen in real time, not after a delayed sync or manual paste.
- As a team member, I want an edit made through my personal AI client to be attributed to me, tagged with which client made it (e.g., "Brylie · via Claude Desktop"), so my teammates know who's accountable for the change while still seeing how it was made.
- As a team member, I want to revoke my personal AI client's connection at any time from my own account settings, without needing an admin, so that I control my own integrations the way I would any other personal app connection.

### Team agent (acting on a team's behalf)

- As a team agent, I want to read the documents I've been granted access to so that I can answer questions and take action with correct context.
- As a team agent, I want to write structured edits (not just append text) so that my changes preserve the document's existing formatting and block structure.
- As a team agent, I want my edits attributed to my agent identity, distinct from any human, so that the audit trail stays accurate.
- As a team agent, I want to be notified when a document I'm watching changes so that I can react to a trigger (e.g., "when this table changes, update the summary block").
- As a team agent, I want to update related content across different documents and modalities — e.g., an event description, a task row, and a draft social post — in one coordinated batch so that dependent content stays in sync in a single pass instead of a human propagating the same change by hand across separate pages.
- As a team agent, I want to query records the same way whether a human currently has them rendered as a Table, a Kanban board, or a Calendar so that my logic doesn't need to know which view a human happens to be looking at.

### Workspace admin

- As a workspace admin, I want to grant an agent access to specific documents or spaces (not the whole workspace by default) so that agent access follows least privilege.
- As a workspace admin, I want to revoke an agent's access instantly so that I can respond immediately to a misbehaving or compromised integration.
- As a workspace admin, I want an audit log of every agent action across the workspace so that I can review what agents have done, not just what they're allowed to do.
- As a workspace admin, I want to set a rate/scope limit per agent (e.g., max edits per hour, no delete permission) so that a runaway or buggy agent can't cause large-scale damage.

### External agent developer

- As an external agent developer, I want to connect my own agent via a documented MCP server so that I can build custom automation on top of the workspace without reverse-engineering an internal API.
- As an external agent developer, I want a sandbox/test workspace so that I can validate my integration before requesting production access.

### Edge cases

- As a team member, I want a clear conflict-resolution outcome when two agents edit the same block simultaneously so that neither edit is silently dropped.
- As a team member, I want my cursor's mere presence in a block to stop an agent from starting to rewrite it so that I don't have to react defensively to an agent invading a paragraph I'm actively reading or about to edit.
- As a workspace admin, I want to be warned before an agent action would affect a large number of documents at once (bulk edit) so that mistakes are caught before they propagate.

## Core Architectural Principle: Unified Data Model

This is the central bet of the spec, and it drives the requirements below more than any single feature does. Rather than building a document editor and, separately, a database/kanban/calendar tool, everything is one primitive:

- A **record** is a typed unit of content with a stable ID and a schema (properties). A paragraph, a heading, a table row, a kanban card, and a calendar event are all records.
- A **Document** is an ordered sequence of block-records (text, heading, list, table, code, embed) — this is the linear, prose-editing surface.
- A **Collection** is a set of records that share a property schema (e.g., Status, Due Date, Owner) — this is the structured-data surface.
- A **View** is a renderer over a Collection's records: Table, Kanban (grouped by a select property), Calendar (positioned by a date property), Gallery, etc. Views do not own data — they query it. Adding a new view type later is a rendering change, not a data migration.
- Both Documents and Collections are addressed identically by the permission model, the audit log, and the agent API (MCP): "read/write this record" is the same operation whether the record is a paragraph in a doc or a row in a table.
- A block's _content_ is a second, finer-grained structure: a sequence of text runs, each carrying marks (bold, italic, strikethrough, code, link, mention) — not a plain string, and not raw Markdown. Block-level operations (hold, write, permissions) don't reach inside this structure; it exists so two humans can concurrently format overlapping ranges of the same paragraph without corrupting each other's changes, the way raw Markdown delimiters would.

**Why this belongs in v1, even with a tight UI surface:** retrofitting this unification after shipping a documents-only data model is the expensive path — it means a schema migration and a second data-access pattern for agents to learn. Getting the record/view separation right now is what makes kanban, calendar, and spreadsheet cheap _additions_ later rather than rewrites. The UI surface in P0 stays deliberately narrow (see below) — only the model is required to be general from day one.

This is also what makes cross-modality agent batches possible, not just cross-document ones. Because a Document block and a Collection record are the same primitive addressed the same way, a single hold set can mix them: planning an event, an agent could hold the event description block in a Document, the corresponding task row in a Table, and a draft announcement block in a separate social-post Document — all in one coordinated batch, none of it modality-specific plumbing. A human doing the same update propagates it by hand across three different pages (or three different tools, without this workspace); the agent does it as one operation because the model doesn't distinguish between them.

**Decision: SvelteKit, and a bespoke block-editor layer on top of Yjs.** Both were open questions; both are now resolved. **SvelteKit** for the application framework — web-standards alignment is a better long-term bet than React's faster churn, it has a well-trodden path to a future desktop build via Tauri, and once the editor itself is bespoke (not adopted), the strongest argument for React (matching an adopted library's framework) no longer applies. **Bespoke, not adopted, for the block-editor UI** — but only the UI layer: Yjs itself, the CRDT sync primitive every candidate below converged on independently, is exactly the kind of solved, non-differentiating problem worth adopting outright, and reimplementing CRDT sync from scratch would be substantial, risky, and add nothing to the product. What's bespoke is the layer above it — block rendering, the rich-text run model, slash-command insertion, and specifically the hold/placeholder/cursor-presence-as-implicit-hold mechanics this spec works out in detail, which no surveyed toolkit implements natively (Blok's `blocks.transact()` comes closest, but still needs real extension to reach our exact non-contiguous, cross-document semantics — at which point adopting it saves less than it first looked like). This also sidesteps every licensing caveat below outright: nothing GPL, nothing to reconcile with the Apache 2.0 goal. Each candidate stays valuable as **design reference**, not code to build on:

- [BlockNote](https://www.blocknotejs.org/) — its AI-editing UX (an agent editing, writing, and formatting blocks directly in the document) is the closest existing reference for what this spec's hold/placeholder UI should feel like from a user's perspective, even though the code isn't being adopted. Its React coupling and GPL-3.0/commercial "XL" AI package would both have ruled it out as an adoption candidate anyway, given SvelteKit and Apache 2.0.
- [BlockSuite](https://github.com/toeverything/blocksuite) — the open-source editor behind AFFiNE — is the best reference for the record/Collection separation itself: block-based, CRDT-native via Yjs from the ground up, MPL-2.0 throughout (would have coexisted fine with an Apache 2.0 project, being weak/file-level copyleft — this wasn't a reason to rule it out, bespoke just won on other grounds).
- [Blok](https://blokeditor.com/) — Apache-2.0, headless, CRDT-backed via Yjs — is the closest reference for the hold-and-atomic-write mechanic specifically; its `blocks.transact()` is worth studying as a model for our own bespoke hold/release implementation, even without adopting the library itself.
- [Editor.js](https://editorjs.io/) — the mature project Blok forked from — is good reference for clean, typed-JSON block schemas.
- WordPress's Gutenberg is reference for the slash-command interaction pattern specifically (see the block editor requirement below); WordPress 7.0's April 2026 Yjs-CRDT rollout is also good external validation that a Yjs-based approach holds up at real scale.

Chat/channels are explicitly not part of this model (see Non-Goals) — that gap is filled by integrating with tools that already solve it well, not by adding a fifth content type here. Worth noting for later: this workspace's P0 audit log is already an append-only, actor/timestamp/content event stream — structurally close to what a chat message would look like — so if coordination features are ever explored, that's the more natural extension point than a new subsystem.

## Requirements

### Must-Have (P0)

**Real-time collaborative editing**

- Multiple humans can co-edit a document concurrently with sub-second latency and no lost edits, using a **CRDT-based sync engine** (not OT) — settled by this spec, not left open. Every technology candidate surveyed above (BlockNote, BlockSuite, Blok, Gutenberg) independently converged on CRDT via Yjs; OT requires a central sequencing server and its transform functions are notoriously hard to get right for block-structured (not plain-text) documents. CRDT also better serves the P2 offline goal. The one remaining task is a performance/memory spike at expected scale, not the algorithm choice. Writes from MCP clients (personal AI apps, team agents, external agents) go through this same sync engine — not a separate polling or batch-import path — so they appear live to anyone else viewing the document.
- _Acceptance:_ Given two users editing the same paragraph, when both submit conflicting edits within 500ms, then both edits merge deterministically with no data loss and no manual conflict UI.
- _Acceptance:_ Given a user has the workspace open in the web UI and, separately, has connected their own AI app (e.g., Claude Desktop) via MCP, when that AI app writes an edit, then the web UI reflects it within the same latency bound as a native co-editor's change, with no manual refresh.

**Unified record data model**

- Content is modeled as typed records per the architecture above. A Document is an ordered sequence of block-records; a Collection is a schema'd set of records. Both share one storage and addressing scheme.
- _Acceptance:_ A record created via any view is addressable and editable through the same record API used by the Document editor — there is no separate data path per modality.
- _Acceptance:_ Given a future view type is added (e.g., Kanban), then it renders by querying existing records grouped by a property, with zero migration of existing data.
- _Acceptance:_ Given an agent holds a set of records spanning a Document block and a Collection row in the same call, then both are held, written, and released through the identical API pattern — the agent does not need modality-specific logic to coordinate a mixed-type batch.
- _Acceptance:_ Given two users apply overlapping inline formatting (e.g., bold and italic) to the same paragraph concurrently, then both marks merge onto the correct text ranges with no corrupted or lost formatting — comparable to Notion's rich-text model (a run array with a `bold`/`italic`/`strikethrough`/`code`/`link` annotation set per run, not a Markdown string) rather than a plain-text CRDT.

**Block editor interaction (formatting + slash-command insertion)**

- Humans style text through a rich-text editor UI — a selection toolbar and/or keyboard shortcuts — never by typing raw markup. Whatever characters appear in the editor are always literal content, never formatting syntax; the underlying rich-text run structure (see Core Architectural Principle) updates directly.
- A slash-command menu (typing `/`) inserts or transforms blocks — heading, list, table, code, embed — following the convention established by Notion, Coda, and WordPress's Gutenberg block inserter.
- Despite the block model underneath, editing must _feel_ like a familiar word processor for the everyday keys and toolbar actions a person already has muscle memory for — Enter, Backspace, and "apply this formatting to what I'm looking at" — rather than exposing the block boundaries as something the person has to work around. Concretely:
  - Enter splits the current block's text at the caret, moving whatever comes after it into a new block, the same way Enter divides a line in Word or Google Docs — it does not silently discard the text after the caret.
  - Backspace with the caret at the very start of a block's text joins that block onto the end of the previous one, the same way Backspace joins two lines in a word processor — not only when the current block happens to be empty.
  - Clicking a text-formatting toolbar control (a heading level, a list type, quote, etc.) while a block is active converts that block in place, preserving its text — the way Word's or Google Docs' toolbar turns the current paragraph into a list item — rather than inserting a new, empty block next to it. Clicking the control matching the block's own current type toggles it back to a plain paragraph, the same way clicking an already-pressed "Bulleted List" button removes that formatting rather than being a one-way action.
  - Pressing Enter at the very start of a list item's text — not just typing normally and hitting Enter at the end — behaves like breaking out of a list in a word processor: the first press starts a new, empty item above the text (as it would for any block split); a second press there, with nothing yet typed into that new item, exits the list, converting it to a plain paragraph rather than adding another empty item. Repeated Enter at the start of a line never produces a growing trail of empty list items.
- _Acceptance:_ Selecting text and applying bold/italic/etc. from the toolbar or a shortcut updates that block's rich-text run structure with no Markdown or other syntax ever visible in the editor.
- _Acceptance:_ Typing `/` opens a filterable command menu; selecting a command inserts or converts the current block without leaving the keyboard.
- _Acceptance:_ Pressing Enter in the middle of a block's text leaves the text before the caret in place and moves the text after it into a new, focused block.
- _Acceptance:_ Pressing Backspace at the start of a non-empty block's text merges it onto the end of the previous block, preserving marks from both, with the caret landing at the join point.
- _Acceptance:_ Clicking a list/heading/quote/etc. toolbar control with a block active converts that block's type without changing its text or creating a new block; clicking it again when the block is already that type converts it back to a paragraph.
- _Acceptance:_ Pressing Enter twice at the start of a list item's text — once to split, once more on the resulting empty item — leaves a plain paragraph where the empty item was and the original text unchanged in the list item below it, not two empty list items.
- **Implementation contract:** [`specifications/rich-text-toolbar.md`](./specifications/rich-text-toolbar.md) defines the persistent toolbar, selection semantics, block insertion, block conversion, split/join editing behavior, and its relationship to slash commands.

**Table view (minimal Collection UI)**

- A single, minimal view — rows and columns with typed properties — proves the model holds structured, non-linear data alongside documents. This is deliberately the _only_ non-Document view in v1; it exists to validate the unified model, not to compete with spreadsheet tools. **Confirmed property-type set: text, number, date, select, checkbox (boolean), relation.** This is deliberately enough to prove Kanban (a select property rendered as board columns) and Calendar (a date property positioning cards) are just alternate renderings once P1 builds them — no new property type needed to validate that claim.
- _Acceptance:_ A user can create a Collection, define typed properties, and add/edit rows without leaving the workspace UI or invoking a different tool.

**Agent identity and attribution**

- Team agents and external agents are first-class workspace members with their own name, avatar, and role — visually and programmatically distinct from human users. A personal AI client (BYO), by contrast, acts _as_ the human who connected it: edits are attributed to that person's identity, tagged with the originating client (e.g., "Brylie · via Claude Desktop") rather than treated as a separate teammate.
- _Acceptance:_ Every edit in the document history and audit log is attributed to a specific identity (human, human-via-client, or agent) with no edit left anonymous or attributed to "System."
- _Acceptance:_ A user can distinguish, for any edit, whether it came from the native UI, a connected personal AI client, or a workspace agent.

**Agent read/write API (MCP server)**

- A documented MCP server exposes read (get document, get record, query a Collection, search workspace) and write operations, permission-scoped per connected identity — whether that's a team agent, an external agent, or a team member's personal AI client. Writes to an existing block are hold → write → release (see the in-progress edit indicator requirement); create/delete on new or removed records don't need a hold, since there's no prior content to protect.
- Block content crosses the MCP boundary as Markdown, not the internal rich-text run structure: **CommonMark plus GitHub-Flavored Markdown's extensions** (tables, task-list checkboxes, strikethrough) as the baseline — both are already deeply represented in what LLMs are trained on, GFM's tables/task-lists cover technical documentation and lightweight business note-taking well, and its checkbox syntax maps directly onto the checkbox property type. On top of that, two small workspace-specific extensions cover what Markdown has no syntax for: `@mention` for mentions and `[[Record Title]]` wiki-style links for relation links (the now-familiar convention from Obsidian/Notion/Roam, which agents are also reasonably likely to already produce correctly). Agents read and write this dialect; the server transcodes to/from the internal rich-text structure. Exact escaping/edge-case behavior for the two extensions is an implementation detail to work out, not a spec-level open question.
- **Phase 0:** the workspace only needs to expose a spec-compliant MCP server; how a personal AI client connects to it is that client's own native configuration (Claude Desktop, Claude Code, and ChatGPT all support pointing at an arbitrary MCP server via their own config, per their respective docs). No in-app "connect your AI app" wizard is needed for one person manually editing a config file — a simple local access token is enough. **Phase 1** is where a real per-user, self-service OAuth-style connection flow (initiated and revocable from a team member's own account settings, no admin action required) becomes necessary, once more than one person's clients need distinct, individually-revocable credentials.
- _Acceptance:_ An agent or client granted access to a single document cannot read or write any other document, verified by an explicit permission-denied test.
- _Acceptance:_ A team member can connect and later disconnect their own personal AI client without any admin action, and disconnecting immediately revokes that client's access.

**Permissions model**

- Access control at the workspace, space, and document level, applicable identically to human and agent identities.
- _Acceptance:_ An admin can grant/revoke a specific agent's access to a specific document without affecting any other agent or human's access.

**Live presence and attribution UI**

- Users see who (human or agent) is currently viewing/editing a document, with per-block edit attribution visible on hover or in a change log.
- _Acceptance:_ A user can identify, for any block, the identity and timestamp of its last editor without leaving the page.

**In-progress agent edit indicator (hold + placeholder)**

- An agent signals it's about to rewrite content by holding a **set of block IDs** before generating — one block or many, and that set has no requirement to be contiguous, ordered, or confined to a single document. This falls out of the unified model for free: since every block/record already carries a globally stable ID (see Core Architectural Principle), a hold is just "this set of IDs is reserved" — it doesn't need to know or care where each one lives. An agent restructuring related content across two documents holds both sets of blocks in one call.
- Each held block renders as a placeholder — shimmer bars sized to the block's normal line height, with the acting agent's avatar in the gutter — deliberately _not_ a blinking text cursor, since an agent writing over MCP has no continuous keystroke stream to attach one to; a fake cursor would promise live feedback that isn't coming.
- The hold is advisory, not a lock, and releases **per block, not all-or-nothing**: a human editing any one held block immediately releases the hold on that block only — the agent's pending write for that specific block is rejected (it must re-read and retry) while the rest of its held set is unaffected. Agent parity does not mean agent priority.
- Holding a block the agent doesn't have write access to (including a cross-document hold where access differs per document) is rejected per-block at hold time, using the same permission check as any other write — a hold is not a way to bypass permissions on part of a multi-block set.
- A human's cursor placed in a block is itself an **implicit hold** under that human's identity — no explicit API call needed for humans, since presence already signals it. This runs through the same per-block hold state an agent's request checks: if an agent's requested set includes a block a human is currently in, that specific block is denied in the response while the rest of the set is granted — extending the per-block (not all-or-nothing) behavior to acquisition, not just release. An implicit hold releases when the cursor moves to a different block (a short debounce, on the order of a second or two, avoids churn from fast navigation — exact timing is an implementation detail to tune, not a spec-level commitment). This is a proactive layer on top of the reactive one above: most conflicts are avoided before they'd ever need the CRDT to resolve anything.
- _Acceptance:_ Given a human's cursor is in a block, when an agent requests a hold on a set that includes that block, then that block is denied in the per-block response while the agent's holds on the rest of the set succeed.
- A hold expires automatically (target: 90–120s) if the agent disconnects or stalls, reverting the block to its prior content so a crashed agent can't leave a placeholder stuck indefinitely.
- The write that fills a placeholder is atomic: content and hold-release land together, so there's never a visible gap where the placeholder is gone but new content hasn't arrived. The swap itself is a brief visible transition (e.g., a short fade/cross-fade), not an instant hard cut — the moment new content lands should be perceptible, matching how a human's incoming edit reads as motion rather than a jump cut.
- _Acceptance:_ Given an agent holds a block, when a human starts typing in that same block, then the hold is released and the human's edit is not overwritten by the agent's in-flight write.
- _Acceptance:_ Given an agent holds a set of blocks spanning two documents and a human edits a block in only one of them, then only that block's hold is released — the agent's holds and pending writes on the other document's blocks proceed unaffected.
- _Acceptance:_ Given an agent holds a block and then disconnects without writing, when the TTL elapses, then the block reverts to its pre-hold content automatically, with no manual cleanup required.

**Audit log**

- Every agent action (read, write, delete) is logged with actor, target, timestamp, and diff, queryable by admins.
- _Acceptance:_ An admin can filter the audit log by agent identity and time range and see every action that agent took.

### Nice-to-Have (P1)

- **Kanban view** — renders a Collection's records as cards grouped by a select-type property (e.g., Status). Pure view logic over P0's record model; no new storage.
- **Calendar view** — renders a Collection's records positioned by a date-type property. Same records as Table/Kanban views of the same Collection.
- **Filter and sort** on any view (Table, Kanban, Calendar) over the same underlying records.
- **Multi-agent concurrent editing on one document**, including visible "agent is editing this block" locks/indicators to avoid two agents corrupting the same block.
- **One-click revert** for any agent edit, scoped to that edit's diff rather than a full document rollback.
- **Rate and scope limits per agent** (max writes/hour, no-delete flag) configurable by admins.
- **Sandbox workspace** for external agent developers to test integrations before requesting production access.

### Future Considerations (P2)

- **Workflow automation / document-level triggers** — a document or block can declare a condition ("on schedule," "on linked-source change") that invokes a named agent to update it, reducing manual upkeep of living documents. Genuinely compelling, but deliberately post-MVP: it's an amplifier on top of collaborative editing and agent parity, which need to be proven solid first. Tracked here so it isn't lost, and revisited once P0/P1 usage data shows where automation would help most.
- **Spreadsheet / formula view** — cell-level formulas and cross-record calculation. Aspirational and low-priority: reserve a "formula" property type in the schema so it isn't a migration later, and leave the design itself undecided until it's actually prioritized — too many open unknowns to spend spec effort on now.
- **Gallery, list, and timeline views** — further renderers over the same Collection model.
- **Streaming agent writes (live token-level cursor)** — for a first-party Team agent runtime we control, a real incremental-write primitive (e.g., repeated `append_to_block` calls) could drive an actual live-typing cursor instead of the P0 hold+placeholder pattern. Deferred because most external agents (Claude Desktop, ChatGPT, Gemini, third-party) call a write tool once with finished content and couldn't use it anyway — hold+placeholder is the pattern that works universally.
- **Chat/coordination tool integration** (e.g., Buzz) — _not_ building channels; instead, letting an agent that already operates inside a tool like [Buzz](https://block.xyz/inside/introducing-buzz-where-humans-and-agents-work-together) connect to this workspace as an External agent over the existing MCP surface, plus (further out) deep-linking from a chat message to a specific record. This is largely "already covered" by the P0 agent API rather than new subsystem work.
- **Agent-to-agent handoff protocols** — one agent delegating a sub-task to another within the same document, with attribution preserved through the chain.
- **Cross-document agent workflows** — an agent workflow that reads/writes across multiple documents or spaces (e.g., roll up five project docs into one status doc).
- **Enterprise compliance** — SSO/SCIM, SOC 2, granular data residency.
- **Offline editing with async merge** — once the real-time core is proven, revisit offline support.
- **Third-party agent marketplace** — a directory of vetted external agents teams can install with one click.

Documenting these now, even though they're out of scope for v1, is meant to prevent the record/permission data model from being designed in a way that makes them hard to add later (e.g., attribution must support a chain of actors, not just a single actor field; property schema must anticipate a formula type).

## Success Metrics

These metrics assume a multi-user population and apply from Phase 1 onward. Phase 0's bar is simpler and qualitative, by design: does the founder actually keep using this daily for real project work, instead of reverting to Notion/docs/chat for the same task? That's the only signal that matters before Phase 1 is worth building at all.

### Leading indicators (days–weeks post-launch)

- **Agent action adoption:** % of active workspaces where at least one agent has written to a document within 7 days of setup. Target: 50%.
- **Time-to-first-agent-edit:** median time from workspace creation to first successful agent write. Target: under 10 minutes (no support ticket required).
- **Edit conflict rate:** % of concurrent edits that surface a visible conflict to the user (should be near-zero given automatic merge). Target: under 1%.
- **Agent write error rate:** % of agent write API calls that fail due to platform issues (not permission denials). Target: under 2%.
- **Unified-model usage rate:** % of active workspaces that create at least one Collection (Table view) in addition to Documents within 30 days. This is the direct signal that the model, not just the document editor, is being used. Target: 30%.
- **Personal AI client connection rate:** % of active users who connect at least one personal AI client (Claude Desktop, ChatGPT, Gemini) within 30 days. Target: 25%. This validates the bring-your-own-client bet specifically, separate from workspace-hosted Team agent adoption.

### Lagging indicators (weeks–months post-launch)

- **Weekly-active-workspace retention** at 8 weeks, benchmarked against comparable human-only collaboration tools at the same lifecycle stage. Target: parity (within 10 percentage points).
- **Agent-attributed edit share:** % of all document edits in a workspace attributed to an agent (not a human), tracked over time as an indicator the "agent-first" value is actually used, not just enabled. Target: 15%+ by week 8 in active workspaces.
- **External agent integrations built:** number of distinct MCP-connected external agents in production use. Target: 10 within the first quarter post-launch of the MCP server.
- **Support tickets citing lost/conflicting edits:** should trend to near-zero as the collaboration core matures.

Measurement method, exact query definitions, and evaluation cadence (1 week / 1 month / 1 quarter) don't need to be finalized now — they're Phase 1 work, once there's a real user population to instrument. Phase 0 has no metrics team and doesn't need one; the founder using the tool daily _is_ the validation.

## Open Questions

None remain open after this review pass — market thesis, instrumentation, application framework, and the editor build-vs-adopt decision are all resolved above. The formula/spreadsheet view (P2) is deliberately left undesigned rather than turned into an open question — it's low-priority enough that speculating on its design now would be noise, not signal. This spec is ready to move into engineering scoping for Phase 0.

## Timeline Considerations

No hard external deadlines (greenfield project, no existing codebase or committed launch date).

**Suggested phasing**, given the broad platform scope — and now split further by single-tenant vs. multi-tenant, per Target Users above:

- **Phase 0 — Personal MVP (single-tenant, local-trust, no login).** Solve the founder's own problem first, for one person on one machine: the unified record model, Document and Table views, the block editor UX (rich text + slash commands), and full agent parity — hold/placeholder with cursor-presence holds, per-agent permission scoping, audit log, MCP read/write, and a personal AI client connected via a simple local token rather than a multi-tenant OAuth flow. Real-time sync is still required — the user's own UI and their own connected AI client (e.g., Claude Desktop) are already two concurrent actors — but _multi-human_ collaboration, a login system, and a workspace-admin role distinct from the one user don't exist yet, because there's no second person to need them. Small enough to build and dogfood solo before anyone else is involved.
- **Phase 1 — Multi-human collaboration + team parity (P0 above, the multi-tenant remainder).** Adds what Phase 0 skipped because it was solo: authentication, multiple humans co-editing with full CRDT conflict resolution between people (not just human+agent), a real workspace-admin role managing other people's membership and permissions, and per-user OAuth for external clients now that "per-user" means more than one person. Triggered by the actual need to share the tool with friends or collaborators, not built ahead of that need.
- **Phase 2 — More views + multi-agent (P1 above).** Kanban and Calendar views (new renderers over Phase 1's model, not new data subsystems), filter/sort, concurrent multi-agent editing, revert, rate limits, sandbox. Depends on Phase 1's record model and attribution being solid; do not start before Phase 1's conflict-resolution behavior is validated with real users.
- **Phase 3 — Scale, automation, and ecosystem (P2 above).** Workflow automation/document triggers, spreadsheet/formula view, additional view types, agent-to-agent handoff, cross-document workflows, enterprise compliance, offline support, agent marketplace. Sequencing within Phase 3 should be driven by whichever P1 metrics (adoption, retention, unified-model usage rate) point to as the binding constraint.

Each phase boundary is a natural checkpoint to re-validate the wedge persona and success metrics before committing engineering time to the next phase.
