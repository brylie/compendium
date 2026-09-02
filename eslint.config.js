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
			// preset: those flag ~300-900 pre-existing findings dominated by
			// Yjs's loosely-typed API surface (no-unsafe-member-access and
			// friends) with low signal for this codebase. These four are the
			// ones that catch a real class of bug — a promise whose rejection
			// is silently dropped, or an async function passed somewhere a
			// signature demands sync — not a stylistic preference.
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': 'error',
			'@typescript-eslint/await-thenable': 'error',
			'@typescript-eslint/no-implied-eval': 'error',

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
			'sonarjs/deprecation': 'off'
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
		// Override or add rule settings here, such as:
		// 'svelte/button-has-type': 'error'
		rules: {}
	}
);
