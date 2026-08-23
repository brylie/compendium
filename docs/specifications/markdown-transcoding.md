# Markdown transcoding

**Depends on:** [`data-model.md`](./data-model.md) (RichText/TextMarks shape)

---

Per the PRD: CommonMark + GFM (tables, task-list checkboxes, strikethrough) as the baseline, plus `@mention` and `[[Record Title]]` as workspace extensions.

- **Read path** (`Y.Text` → Markdown): walk the `Y.Text`'s formatted ranges, emit standard Markdown syntax for each mark (`**bold**`, `` `code` ``, `[text](url)`), plus `@mention` for a `mention` mark and `[[Title]]` for a `relation`-typed property value resolved to its target record's title.
- **Write path** (Markdown → `Y.Text`): parse with a standard CommonMark+GFM parser (e.g., `remark` — pure JS, no framework coupling, fits a bespoke SvelteKit-side build), walk the resulting AST, apply `Y.Text.format()` calls for each inline mark, and resolve `@mention`/`[[...]]` tokens against the workspace's actor/record indices before writing.
- Kept as a small internal module (`markdown-transcode.ts`) independent of both the UI and the MCP server, since both may eventually need it (e.g., pasting Markdown into the editor UI directly).
