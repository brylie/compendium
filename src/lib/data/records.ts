// Compatibility facade (#191) — this module used to be a single 1,600+ line
// file spanning Yjs serialization, Document hierarchy, Collection schema
// policy, record/block CRUD, and migration-copy primitives. It's split into
// cohesive modules now (document-ops.ts, collection-ops.ts, record-ops.ts,
// migration-copy.ts, plus the internal-only yjs-shapes.ts/view-config.ts/
// errors.ts foundations), but ~50 files still import from `$lib/data/records`
// directly — client `.svelte` components read Yjs live off these same
// exports (architecture.md §2: UI and MCP share one data-access layer), not
// just the service layer — so this file re-exports every one of them under
// its original name rather than touching every call site. Add a new
// low-level CRDT operation to the relevant module above, not here.
export * from './errors';
export * from './document-ops';
export * from './collection-ops';
export * from './record-ops';
export * from './migration-copy';
