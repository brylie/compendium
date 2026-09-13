# Workspace export and periodic Markdown mirror

**Depends on:** [`data-model.md`](./data-model.md), [`markdown-transcoding.md`](./markdown-transcoding.md), [`mcp-tools.md`](./mcp-tools.md), [`service-layer.md`](./service-layer.md)  
**See also:** [`backup-recovery.md`](./backup-recovery.md) (#19 - binary database DR backups), [`persistence.md`](./persistence.md)

---

## 1. Problem and Rationale

The Compendium README frames "nothing to export, import, or paste between them" around avoiding manual copy-paste round-tripping between browser UIs and AI tools — not about data lock-in. Users retain full data ownership and need a simple, open way to extract human-readable workspace data for backup, local search, external archiving, or migration to other tools (e.g. Obsidian, Notion, or plain Markdown note folders).

This specification addresses Issue #17 by defining:

1. **On-demand export formats & scopes**: Structured Markdown files + `manifest.json` for Documents, Collections, and full Workspaces or Spaces.
2. **Restore/import compatibility story**: A documented manifest schema that powers future import/restore tools (#26). Note that Markdown export restores high-level document tree hierarchy and content, but is lossy for internal block record IDs and detailed block-level UI state (`checked`, `collapsed`, `viewConfig`, `calloutStyle`).
3. **Periodic, disposable Markdown mirror**: An automatic, non-authoritative, user-toggleable disk mirror regenerated from live `Y.Doc` state for instant local searchability (e.g. `ripgrep`, external note readers).

---

## 2. On-Demand Export Formats and Scopes

### 2.1 Export Scopes

Compendium supports exporting data at three granularities:

- **Single Document**: Exports a document as Markdown. If `includeChildren` is requested, exports child pages nested in matching subdirectories.
- **Single Collection**: Exports collection schema definitions (properties, view configs) as JSON, along with rows serialized as both structured JSON (`records.json`) and CSV (`records.csv`).
- **Full Workspace / Space**: Exports all accessible Documents and Collections in the workspace or a specific Space, organized in a clean directory hierarchy with a top-level `manifest.json`.

### 2.2 Export Package Layout

A workspace export produces a zip archive or filesystem directory with the following layout:

```text
export-<workspaceId>-<timestamp>/
├── manifest.json                  # Workspace export manifest & hierarchy index
├── documents/
│   ├── Getting Started.md
│   ├── Projects/
│   │   ├── Q3 Roadmap.md
│   │   └── Architecture.md
└── collections/
    ├── Task Board/
    │   ├── schema.json            # Collection schema & property definitions
    │   ├── records.json           # Raw JSON array of collection records
    │   └── records.csv            # Tabular CSV view of collection records
```

### 2.3 The Manifest Schema (`manifest.json`)

The `manifest.json` file guarantees that an export is structured, self-contained, and non-proprietary:

```json
{
	"version": "1.0",
	"exportedAt": 1757760000000,
	"workspaceId": "default",
	"spaceId": "default",
	"documents": [
		{
			"id": "doc_123",
			"title": "Getting Started",
			"parentDocumentId": null,
			"order": "a0",
			"path": "documents/Getting Started.md"
		}
	],
	"collections": [
		{
			"id": "col_456",
			"title": "Task Board",
			"schemaPath": "collections/Task Board/schema.json",
			"recordsPath": "collections/Task Board/records.json"
		}
	]
}
```

---

## 3. Restore and Import Story

While full Markdown/Obsidian import is tracked separately under #26, the export format is explicitly designed to avoid dead ends:

- **Lossless Metadata**: `manifest.json` preserves exact document titles, IDs, parent-child hierarchy, fractional index ordering, and collection property types (`text`, `number`, `date`, `select`, `checkbox`, `relation`).
- **Standard CommonMark + GFM**: Document files are standard CommonMark Markdown with GFM extensions. Inline wiki-links (`[[Target Title]]` or `[[Target Title|record:id]]`) reference either title or target ID.
- **Importer Compatibility**: A restore/import tool (#26) reads `manifest.json` first to construct the Document hierarchy and Collection schemas, then parses each `.md` file into `Y.Text` block CRDTs.

---

## 4. Periodic Disposable Markdown Mirror on Disk

### 4.1 Concept and Constraints

- **Disposable & Non-Authoritative**: The Markdown mirror is a derived, read-only projection generated one-directionally from live `Y.Doc` state (the same architectural pattern `persistence.md` §2 uses for `record_index`). It is **never** a parallel write path: editing files in the mirror directory does not update Compendium.
- **Always-Fresh Local Copy**: Allows local CLI tools (e.g. `ripgrep`, `find`, `obsidian`) to query workspace contents directly from the filesystem without hitting HTTP or database APIs.

### 4.2 User Configuration & Defaults

The mirror is **off by default** and configured via user settings:

- `enabled`: boolean (`false` by default).
- `outputDir`: path string (defaults to `.data/markdown-mirror` relative to workspace root).
- `syncIntervalMs`: synchronization frequency (default 60,000 ms / 1 minute, or triggered on workspace flush).

### 4.3 Mirror File Synchronization

When enabled, a background sync service (`syncMarkdownMirror` in `src/lib/services/export.ts` / `src/lib/server/markdown-mirror.ts`):

1. Resolves all workspace documents and collections.
2. Writes updated Markdown files for documents and summary files for collections to `outputDir`.
3. Cleans up orphaned Markdown files corresponding to deleted documents/collections.

---

## 5. Service Layer Integration

Export and mirror functions live in `src/lib/services/export.ts` and are registered in `manifest.ts`:

- `export.exportWorkspace`: Generates a full workspace export bundle (`manifest.json`, `documents/`, `collections/`).
- `export.exportDocument`: Generates export data for a single Document.
- `export.exportCollection`: Generates export data for a single Collection.
- `export.getMirrorConfig`: Retrieves current Markdown mirror configuration.
- `export.updateMirrorConfig`: Updates mirror settings (`enabled`, `outputDir`).
- `export.syncMarkdownMirror`: Triggers an immediate mirror sync tick.

---

## 6. User Interface & API Surfaces

- **Settings UI (`/settings/export` or `/settings`)**:
  - UI section to trigger manual export downloads (ZIP archive).
  - UI form to toggle the Markdown Mirror and configure its output directory.
- **API Endpoint (`/api/export`)**:
  - Endpoint for downloading ZIP packages of single documents, single collections, or full workspaces.
