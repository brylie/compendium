# Changelog

All notable changes to Compendium will be documented in this file.

The project follows [Semantic Versioning](https://semver.org/). Git release
tags use the `vX.Y.Z` convention.

## [0.1.0] - 2026-08-28

Compendium's first public pre-release establishes the core human–agent
collaboration loop: people and MCP agents work on the same live knowledge
workspace with scoped access, visible coordination, and attributed changes.

### Added

- A rich-text document editor with nested pages, slash commands, a persistent
  toolbar, and local per-actor undo and redo.
- Collections with editable Table, Board, and Calendar views, including views
  embedded directly inside documents.
- Real-time CRDT synchronization across the browser UI and MCP clients.
- MCP tools for reading, searching, creating, moving, and editing documents,
  collections, and records.
- Per-record agent holds, human presence, conflict-safe writes, scoped access
  tokens, and a queryable audit trail.
- Stable internal page links, `[[wiki links]]`, explicit broken-link handling,
  and live backlinks.
- SQLite-backed workspace snapshots, access tokens, and audit history.
- Protocol-level and browser-level end-to-end coverage for the collaboration
  boundary.

### Project status

This is a single-tenant, local-trust pre-release intended for local use with
desktop MCP clients. Multi-tenant authentication and production hardening
remain on the roadmap.

[0.1.0]: https://github.com/brylie/compendium/releases/tag/v0.1.0
