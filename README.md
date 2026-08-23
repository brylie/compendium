# Compendium

A shared knowledge workspace where people and AI agents read and write the
same pages and tables — live, in the same place, with nothing to export,
import, or paste between them.

## Why

Most knowledge tools were built for humans and had agents bolted on
afterward: a chat sidebar, or a one-shot "generate this page" button. They
can't reliably read the rest of a workspace, hold a durable identity, or
write back into a document the way a human collaborator would. In practice
this means pasting agent output between chat windows and documents by hand —
which breaks the audit trail, duplicates work, and lets the document drift
out of sync with what the agent actually knows or did.

It's not that in-place agent editing is impossible — Gemini edits Google
Docs in place now, Copilot edits Word in place — it's that it's walled to
each vendor's own ecosystem. An assistant reaching into a file format
outside its home turf creates a new file instead of updating the one that's
open. **MCP-based editing sidesteps that by construction**: the workspace,
not any one vendor's document format, is the shared surface, so any
MCP-compatible agent — Claude, ChatGPT, Gemini, a custom bot — gets the same
in-place read/write access as a human editing in the native UI.

The other half of the bet: documentation, structured data, kanban, and
calendars are usually separate tools, each with their own data model, so
neither humans nor agents can treat "what the team knows" as one queryable
thing. Compendium models all of it as one thing — see below.

Full product rationale, including the persona/market thesis and what's
explicitly _not_ being built, lives in
[`docs/agent-workspace-prd.md`](docs/agent-workspace-prd.md).

## What it is

Everything — a paragraph, a heading, a table row, a kanban card — is the
same underlying kind of thing, addressed the same way by the UI, the
permission model, the audit log, and the MCP tools an agent uses. That's
what lets an agent treat a Document and a Table as one connected workspace
instead of two disconnected apps.

- A **Document** is a page: an ordered sequence of blocks, the
  prose-editing surface.
- A **Collection** is a structured dataset: a set of records sharing a
  schema (text, number, date, select, checkbox, relation).
- A **View** renders a Collection (Table today; Kanban and Calendar are
  planned as new renderers over the same data, not a migration).
- Text within a block can be independently formatted (bold, italic, code,
  links, `@mentions`), and two people — or a person and an agent — can edit
  the same paragraph at the same time without clobbering each other.

Because a Document block and a Collection row are the same kind of thing
under the hood, an agent can update several at once as a single step — e.g.
an event's description in a Document, its task row in a Table, and a draft
announcement in a separate Document, updated together instead of by three
hand-propagated edits.

## How it works

One server holds the whole workspace and keeps every connected client in
sync in real time. The web UI and any connected MCP agent are looking at
the same live workspace, not separate copies — there's no import/export
step and no polling delay, so a change from either side shows up everywhere
else immediately.

Before an agent overwrites existing content, it visibly claims the blocks
it's about to change — they show a shimmer and the agent's name — so a
human working nearby doesn't get overwritten mid-edit, and so two agents
don't collide. A human's own cursor works the same way: being in a block is
itself an implicit claim on it.

Everything is saved centrally with a full history of who changed what.

Full architecture, the sync engine, and the MCP tool surface live in
[`docs/specifications/`](docs/specifications/).

## Running it

```sh
npm install
npm run dev          # http://localhost:5173, with /ws and /mcp on the same port
```

For a production-style run (one process, built for production):

```sh
npm run build
ORIGIN=http://localhost:3000 npm start
```

Set `ORIGIN` to whatever host/port you're actually serving on — it's used
to validate incoming requests and only matters if you're scripting requests
yourself.

## Connecting an MCP client

1. Create a document or collection from the workspace home page.
2. Go to **Tokens** (`/settings/tokens`), create a token scoped to the
   documents/collections you want to grant access to.
3. Point your MCP client (Claude Desktop, Claude Code, ChatGPT, etc.) at
   `http://localhost:5173/mcp` (the `npm run dev` port above) with that token
   as a bearer token, per your client's own remote-MCP-server configuration.
   Substitute your actual host/port if running the production build instead.

Edits made this way appear live in any open browser tab, and vice versa —
MCP and the UI are editing the same workspace (see
[`docs/specifications/architecture.md` §1](docs/specifications/architecture.md)).

## Testing

```sh
npm run test           # vitest — data layer, holds, and markdown transcoding
npm run test:e2e       # tier-a (vitest, protocol-level) + tier-b (playwright, DOM-level)
npm run check           # svelte-check
npm run lint             # prettier + eslint
```

The E2E suites exist specifically to prove MCP writes and UI edits stay in
sync across the real transport boundary in both directions — human creates,
agent edits and vice versa — not just that each side works in isolation. See
[`docs/specifications/e2e-testing.md`](docs/specifications/e2e-testing.md).

## Roadmap

The [Compendium GitHub Project](https://github.com/users/brylie/projects/6) is the
canonical roadmap. Open work is tracked as [GitHub Issues](https://github.com/brylie/compendium/issues)
and organized there, not in local planning docs.

## Further reading

Product rationale and the canonical specification for each implemented
subsystem have their own doc under [`docs/`](docs/) and are kept current
there rather than mirrored here:

- [`agent-workspace-prd.md`](docs/agent-workspace-prd.md) — problem
  statement, goals/non-goals, requirements, and the build-vs-adopt decisions
  behind the editor.
- [`specifications/`](docs/specifications/) — one doc per subsystem
  (architecture, data model, collaboration/holds, MCP tools, markdown
  transcoding, persistence, service layer, testing strategy, design system),
  indexed in that folder's own [`README.md`](docs/specifications/README.md).

## License

Apache 2.0 — see [`LICENSE`](LICENSE).
