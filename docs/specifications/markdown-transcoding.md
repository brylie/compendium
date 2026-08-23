# Markdown transcoding

**Depends on:** [`data-model.md`](./data-model.md) (RichText/TextMarks shape)

---

Per the PRD: CommonMark + GFM (tables, task-list checkboxes, strikethrough) as the baseline, plus `@mention` and `[[Record Title]]` as workspace extensions.

- **Read path** (`Y.Text` → Markdown): walk the `Y.Text`'s formatted ranges, emit standard Markdown syntax for each mark (`**bold**`, `` `code` ``, `[text](url)`), plus `@mention` for a `mention` mark and `[[Title]]` for a `link` mark whose href uses an internal `record:` scheme — i.e. an in-block wiki-link to another Document/Collection, resolved to that target's title at read time.
- **Write path** (Markdown → `Y.Text`): parse with a standard CommonMark+GFM parser (e.g., `remark` — pure JS, no framework coupling, fits a bespoke SvelteKit-side build), walk the resulting AST, apply `Y.Text.format()` calls for each inline mark, and resolve `@mention`/`[[...]]` tokens against the workspace's actor/record indices before writing.
- **Not the same thing as a `relation`-typed Collection property.** `[[Title]]` above is block-content markup — a wiki-link inside a paragraph's `Y.Text` — and is always resolved by matching a Document/Collection **title**, with no notion of a stable target ID once written (an edited title breaks the resolution the next time it's read). A `relation`-typed property (`data-model.md` §1) is a different boundary entirely: it's a plain array of record IDs stored directly on `WorkspaceRecord.properties`, set and read as-is by `write_record`'s `properties` argument and `query_collection` — it is never transcoded through `Y.Text` or Markdown, so it isn't affected by this module's title-matching limitation and keeps stable target identity even across a title rename. Where duplicate titles exist, only the `[[Title]]` wiki-link path is ambiguous (first match wins); `relation` properties are unaffected since they never resolve by title.
- Kept as a small internal module (`markdown-transcode.ts`) independent of both the UI and the MCP server, since both may eventually need it (e.g., pasting Markdown into the editor UI directly).
