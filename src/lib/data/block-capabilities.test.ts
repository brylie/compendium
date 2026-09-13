import { describe, expect, it } from 'vitest';
import { BLOCK_CAPABILITIES } from './block-capabilities';
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
});
