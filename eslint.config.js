import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';
import jsdoc from 'eslint-plugin-jsdoc';
import tsdoc from 'eslint-plugin-tsdoc';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	// Nested assistant worktrees are separate repositories, not project source.
	{ ignores: ['.claude/**'] },
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	security.configs.recommended,
	sonarjs.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
			// Enables the type-aware rules below repo-wide, not just for .svelte
			// files (which already needed it for svelte-eslint-parser). Slower
			// than syntax-only linting, but these specific rules need real type
			// information to work at all. allowDefaultProject covers the
			// handful of root-level scripts tsconfig.json's own `include`
			// deliberately doesn't cover (it's scoped to src/tests/vite/
			// playwright) — without it, typescript-eslint fatally errors on
			// each one instead of just skipping the type-aware rules there.
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'prettier.config.js',
						'drizzle.config.ts',
						'server.ts',
						'scripts/*.ts'
					]
				},
				tsconfigRootDir: import.meta.dirname
			}
		},
		plugins: { jsdoc, tsdoc },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off',

			// A deliberately curated slice of typescript-eslint's *TypeChecked
			// rule sets, not the full recommendedTypeChecked/strictTypeChecked
			// preset (see the src/lib/data override below and issue #174 for
			// the measured reason). These four are the ones that catch a real
			// class of bug — a promise whose rejection is silently dropped, or
			// an async function passed somewhere a signature demands sync —
			// not a stylistic preference.
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': 'error',
			'@typescript-eslint/await-thenable': 'error',
			'@typescript-eslint/no-implied-eval': 'error',

			// Independently-adoptable typescript-eslint *TypeChecked rules
			// (strict/stylistic, not in the curated four above) — measured at
			// under 70 findings total repo-wide, none Yjs-related, so unlike
			// the no-unsafe-* family below they don't need the src/lib/data
			// wrapper first. See issue #174's canonical rule-adoption comment.
			'@typescript-eslint/prefer-nullish-coalescing': 'error',
			'@typescript-eslint/no-deprecated': 'error',
			'@typescript-eslint/array-type': 'error',
			'@typescript-eslint/consistent-type-definitions': 'error',
			'@typescript-eslint/prefer-optional-chain': 'error',
			'@typescript-eslint/prefer-includes': 'error',
			'@typescript-eslint/consistent-generic-constructors': 'error',
			'@typescript-eslint/no-dynamic-delete': 'error',
			'@typescript-eslint/no-misused-spread': 'error',
			'@typescript-eslint/no-useless-default-assignment': 'error',
			'@typescript-eslint/no-unnecessary-type-parameters': 'error',
			'@typescript-eslint/no-base-to-string': 'error',
			'@typescript-eslint/restrict-template-expressions': 'error',
			'@typescript-eslint/restrict-plus-operands': 'error',
			'@typescript-eslint/unbound-method': 'error',

			// Deliberately NOT adopted repo-wide, even though each is real
			// typescript-eslint *TypeChecked coverage (issue #174's canonical
			// comment measured these against strictTypeChecked):
			//  - no-non-null-assertion (172 hits): this codebase deliberately
			//    uses `!` after establishing an invariant on the preceding
			//    line (e.g. `map.get(id)!` right after `.has(id)`), not
			//    carelessly — banning it wholesale forces uglier `as` casts
			//    (working against the no-unsafe-* goal below) or a large
			//    cosmetic refactor for no safety gain.
			//  - no-confusing-void-expression (229 hits): fires on idiomatic
			//    Svelte `onclick={() => doThing()}` handlers, not bugs.
			//  - no-unnecessary-condition (65), require-await (33),
			//    no-empty-function (37): each mixes real hits with legitimate
			//    cases (defensive runtime checks, interface-mandated async
			//    signatures, intentional no-op stubs) and needs case-by-case
			//    triage, not blanket adoption.
			// Worth a deliberate, separately-scoped follow-up, not a blocker
			// for the wrapper work below.

			// detect-object-injection flags every `obj[dynamicKey]` read/write —
			// including plain, safe Record<string, T> indexing, which is most of
			// this codebase's actual usage (WorkspaceRecord.properties, schema
			// lookups by key, etc.). Its false-positive rate is high enough that
			// disabling it, while keeping the rest of security/recommended's
			// rules (unsafe regex, non-literal fs paths, implied eval, etc.), is
			// the documented common practice for this plugin.
			'security/detect-object-injection': 'off',

			// TSDoc coverage: every exported function/class/arrow-function gets
			// a doc comment (publicOnly — an unexported helper stays covered by
			// this codebase's existing "why, not what" inline-comment
			// convention instead, per CLAUDE.md). Deliberately NOT paired with
			// jsdoc/require-param or jsdoc/require-returns: this repo's existing
			// comment style favors a tight, purpose-focused summary over
			// mechanically restating a self-explanatory parameter's name and
			// type, and requiring @param tags across ~130 functions would push
			// toward exactly that kind of boilerplate. A docstring is free to
			// add @param/@returns wherever the parameter or return value isn't
			// self-evident from its name and type; tsdoc/syntax below just
			// makes sure any TSDoc tags actually used are well-formed.
			'jsdoc/require-jsdoc': [
				'error',
				{
					publicOnly: true,
					require: {
						FunctionDeclaration: true,
						ClassDeclaration: true,
						MethodDefinition: false,
						ArrowFunctionExpression: true,
						FunctionExpression: true
					}
				}
			],
			'jsdoc/check-alignment': 'error',
			'jsdoc/check-tag-names': ['error', { typed: true }],
			'tsdoc/syntax': 'error'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		},
		rules: {
			// A Svelte 5 {#snippet} compiles to a function with no explicit JS
			// `return`, and `{@render someSnippet(...)}` isn't "using a
			// function's return value" the way a plain call expression is —
			// it's template syntax. sonarjs's analyzer doesn't know about
			// snippets and misreads every recursive {@render} of one (Sidebar's
			// tree, this route's doc tree, etc.) as consuming an empty return.
			'sonarjs/no-use-of-empty-return-value': 'off',
			// sonarjs/deprecation's reported line/column don't reliably
			// correspond to the actual deprecated-API usage in a .svelte
			// file (confirmed on BlockEditor.svelte's keyCode check — the
			// finding lands on an unrelated line with no deprecated symbol
			// anywhere near it), a parser/source-map interaction between
			// sonarjs's type-aware check and svelte-eslint-parser's virtual
			// TS module. Off here; still active for plain .ts files.
			'sonarjs/deprecation': 'off',
			// no-useless-default-assignment's autofix doesn't recognize Svelte
			// 5's `$bindable()` rune macro as anything other than a removable
			// default value — it silently rewrote `config = $bindable()` to
			// `config` on ViewToolbar.svelte, turning `bind:config` at every
			// call site into a compile error (props are no longer bindable
			// without `$bindable()`). Off here; still active for plain .ts
			// files, where no such macro exists to misread.
			'@typescript-eslint/no-useless-default-assignment': 'off'
		}
	},
	{
		// The Yjs data layer: every CRDT read here goes through the typed
		// wrapper in yjs-typed.ts (issue #174) instead of a raw `Y.Map<unknown>`
		// `as X` cast, so the no-unsafe-*/no-unnecessary-type-assertion rules
		// that fire ~250 times repo-wide (dominated by Svelte component event
		// handlers and MCP/API route+test mocks — unrelated to Yjs, and a
		// separate, larger cleanup) apply cleanly here with zero findings.
		// Scoped rather than repo-wide so this file's contract stays enforced
		// without forcing that unrelated cleanup as part of this change; add a
		// file here if it's migrated onto the wrapper too. Covers every module
		// records.ts (now a re-export facade, #191) was split into — they all
		// follow the same TypedYMap pattern, not just the facade's old single
		// file.
		files: [
			'src/lib/data/records.ts',
			'src/lib/data/yjs-typed.ts',
			'src/lib/data/yjs-shapes.ts',
			'src/lib/data/view-config.ts',
			'src/lib/data/document-ops.ts',
			'src/lib/data/collection-ops.ts',
			'src/lib/data/record-ops.ts',
			'src/lib/data/migration-copy.ts'
		],
		rules: {
			'@typescript-eslint/no-unsafe-assignment': 'error',
			'@typescript-eslint/no-unsafe-member-access': 'error',
			'@typescript-eslint/no-unsafe-argument': 'error',
			'@typescript-eslint/no-unsafe-call': 'error',
			'@typescript-eslint/no-unsafe-return': 'error',
			'@typescript-eslint/no-unnecessary-type-assertion': 'error'
		}
	},
	{
		// yjs's own YText.d.ts declares no `toString()` override (only
		// `toJSON(): string`), so no-base-to-string can't see that Y.Text
		// really does implement a meaningful toString() at runtime — Yjs's
		// own UndoManager.d.ts doc comment relies on exactly this
		// (`ytext.toString() // => ''`). A type-declaration gap in the
		// library, not a real risk here — these two files are the ones that
		// call `.toString()` on a Y.Text directly in assertions.
		// Route folders use literal `[param]` brackets, which the glob
		// matcher reads as a character class rather than literal text — `*`
		// sidesteps that instead of escaping every bracket.
		files: ['src/lib/client/undo.test.ts', 'src/routes/space/*/doc/*/BlockEditor.svelte.test.ts'],
		rules: {
			'@typescript-eslint/no-base-to-string': 'off'
		}
	},
	{
		// Test fixtures/helpers aren't public API surface — excluded from the
		// coverage/complexity/security tiers added above, which exist to keep
		// the app's real surface documented and safe, not to police test code.
		files: ['**/*.test.ts', '**/*.test.js', 'tests/**/*.ts'],
		rules: {
			'jsdoc/require-jsdoc': 'off',
			'sonarjs/cognitive-complexity': 'off',
			'security/detect-object-injection': 'off',
			// A test file that specifically exercises a deprecated browser API
			// (e.g. caret.test.ts mocking document.caretRangeFromPoint — see
			// caret.ts's own per-line disable for the same API) necessarily
			// names that API repeatedly by design; policing that the same way
			// as production call sites just adds noise, not signal.
			'@typescript-eslint/no-deprecated': 'off',
			// Test fixtures routinely build fs paths from their own generated
			// temp directories (mkdtempSync et al.) — self-produced, never
			// request- or user-supplied, so there's no path-traversal risk this
			// rule exists to catch.
			'security/detect-non-literal-fs-filename': 'off',
			// Same reasoning, for regexes: E2E specs build `new RegExp(...)`
			// from this codebase's own internally-generated record ids (e.g.
			// `page.waitForURL(new RegExp(`/doc/${docId}`))`) to match a URL —
			// never from external input, so no ReDoS surface.
			'security/detect-non-literal-regexp': 'off'
		}
	},
	{
		// Root-level tooling config (drizzle/prettier/vite/playwright/eslint
		// itself) — plain build config, not app API surface, so out of scope
		// for the doc-coverage tier. prettier.config.js in particular uses
		// classic JSDoc `@type {import(...).Config}` typing (the standard way
		// to type a plain .js file without converting it to .ts), which
		// jsdoc/check-tag-names and tsdoc/syntax otherwise misread as an
		// undefined/malformed TSDoc tag — TSDoc and classic JSDoc `@type` are
		// different systems.
		files: ['*.config.js', '*.config.ts'],
		rules: {
			'jsdoc/require-jsdoc': 'off',
			'jsdoc/check-tag-names': 'off',
			'tsdoc/syntax': 'off'
		}
	},
	{
		// Dependency-boundary enforcement (#191): the data/repository and
		// service layers must stay protocol-neutral — service-layer.md already
		// said MCP tool handlers must not call records.ts directly, but nothing
		// stopped the reverse: services/documents.ts and services/records.ts
		// both imported richTextToMarkdown/markdownToRichText from
		// src/lib/mcp/markdown-transcode.ts (since relocated to
		// src/lib/data/markdown-transcode.ts, a plain Y.Text<->Markdown codec
		// with no MCP-specific dependency of its own) before this rule existed
		// to catch it. No eslint-plugin-boundaries/import/no-restricted-paths
		// dependency needed — built-in no-restricted-imports, scoped by `files`
		// the same way the Yjs-typed-map override above is, is enough.
		files: ['src/lib/data/**/*.ts', 'src/lib/server/**/*.ts', 'src/lib/services/**/*.ts'],
		ignores: ['**/*.test.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['$lib/mcp/*', '$lib/mcp'],
							message:
								'Data/repository/service modules must stay protocol-neutral (#191) — do not import from the MCP layer. If both sides need this logic, it belongs in $lib/data or $lib/server instead.'
						}
					]
				}
			]
		}
	},
	{
		// Override or add rule settings here, such as:
		// 'svelte/button-has-type': 'error'
		rules: {}
	}
);
