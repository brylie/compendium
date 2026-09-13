import { describe, expect, it } from 'vitest';
import { BLOCK_CAPABILITIES, blockCapabilitiesFor } from './block-capabilities';
import { blockTypes, columnChildBlockTypes, type BlockType } from './types';

describe('BLOCK_CAPABILITIES', () => {
	const alphabetically = <T extends string>(values: readonly T[]) =>
		[...values].sort((a, b) => a.localeCompare(b));

	it('declares every BlockType exactly once', () => {
		expect(alphabetically(Object.keys(BLOCK_CAPABILITIES) as BlockType[])).toEqual(
			alphabetically(blockTypes)
		);
	});

	it('only declares childBlockTypes for a container type', () => {
		for (const blockType of blockTypes) {
			const capabilities = BLOCK_CAPABILITIES[blockType];
			if (capabilities.isContainer) {
				expect(capabilities.childBlockTypes, blockType).toBeDefined();
			} else {
				expect(capabilities.childBlockTypes, blockType).toBeUndefined();
			}
		}
	});

	it('never marks a container as holding its own free-form text', () => {
		for (const blockType of blockTypes) {
			const capabilities = BLOCK_CAPABILITIES[blockType];
			if (capabilities.isContainer) {
				expect(capabilities.holdsFreeformText, blockType).toBe(false);
			}
		}
	});

	it("matches column's curated child-type subset (data-model.md §3.1)", () => {
		expect(BLOCK_CAPABILITIES.column.childBlockTypes).toBe(columnChildBlockTypes);
	});

	it('only lets a columns block directly hold column blocks', () => {
		expect(BLOCK_CAPABILITIES.columns.childBlockTypes).toEqual(['column']);
	});

	describe('blockCapabilitiesFor', () => {
		it('returns the table entry for every known BlockType', () => {
			for (const blockType of blockTypes) {
				expect(blockCapabilitiesFor(blockType)).toBe(BLOCK_CAPABILITIES[blockType]);
			}
		});

		it('falls back to a safe leaf default instead of throwing for an unrecognized value', () => {
			// A value a live Yjs record could carry that this client's own code
			// doesn't recognize yet (e.g. a newer block type written by another,
			// differently-versioned client) — TypedYMap.get only casts, it never
			// validates, so this is reachable at runtime despite BlockType being
			// a closed union at the type level.
			const unknown = 'future_block_type' as BlockType;
			expect(() => blockCapabilitiesFor(unknown)).not.toThrow();
			const fallback = blockCapabilitiesFor(unknown);
			expect(fallback.isContainer).toBe(false);
			expect(fallback.holdsFreeformText).toBe(false);
			expect(fallback.fields).toEqual({ creatable: [], writable: [], readOnly: [] });
			expect(fallback.markdown.writable).toBe(false);
		});
	});

	describe('the shared per-type contract (issue #29)', () => {
		it('gives every BlockType a non-empty label and description', () => {
			for (const blockType of blockTypes) {
				const capabilities = BLOCK_CAPABILITIES[blockType];
				expect(capabilities.label, blockType).not.toBe('');
				expect(capabilities.description, blockType).not.toBe('');
			}
		});

		it("only lists 'content' as writable when the type holds free-form text", () => {
			for (const blockType of blockTypes) {
				const capabilities = BLOCK_CAPABILITIES[blockType];
				expect(capabilities.fields.writable.includes('content'), blockType).toBe(
					capabilities.holdsFreeformText
				);
				expect(capabilities.markdown.writable, blockType).toBe(capabilities.holdsFreeformText);
			}
		});

		it('never gives a container type its own creatable/writable content fields', () => {
			for (const blockType of blockTypes) {
				const capabilities = BLOCK_CAPABILITIES[blockType];
				if (capabilities.isContainer) {
					expect(capabilities.fields.writable, blockType).toEqual([]);
				}
			}
		});

		it('only declares referencedRecordSemantics for a type that actually uses referencedRecordId', () => {
			const referencingTypes = ['synced_block', 'page_link', 'collection_view', 'child_pages'];
			for (const blockType of blockTypes) {
				const capabilities = BLOCK_CAPABILITIES[blockType];
				if (referencingTypes.includes(blockType)) {
					expect(capabilities.referencedRecordSemantics, blockType).toBeDefined();
				} else {
					expect(capabilities.referencedRecordSemantics, blockType).toBeUndefined();
				}
			}
		});
	});
});
