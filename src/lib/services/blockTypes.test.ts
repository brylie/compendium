import { describe, expect, it } from 'vitest';
import { BLOCK_CAPABILITIES } from '$lib/data/block-capabilities';
import { blockTypes } from '$lib/data/types';
import { BLOCK_TYPE_SCHEMA_VERSION, listBlockTypes } from './blockTypes';

describe('listBlockTypes', () => {
	it('returns one descriptor per BlockType, sourced from BLOCK_CAPABILITIES', () => {
		const result = listBlockTypes();
		expect(result.schemaVersion).toBe(BLOCK_TYPE_SCHEMA_VERSION);
		expect(result.blockTypes).toHaveLength(blockTypes.length);

		for (const descriptor of result.blockTypes) {
			const capabilities = BLOCK_CAPABILITIES[descriptor.blockType];
			expect(descriptor.label).toBe(capabilities.label);
			expect(descriptor.description).toBe(capabilities.description);
			expect(descriptor.capabilities).toEqual({
				isContainer: capabilities.isContainer,
				childBlockTypes: capabilities.childBlockTypes,
				holdsFreeformText: capabilities.holdsFreeformText
			});
			expect(descriptor.fields).toBe(capabilities.fields);
			expect(descriptor.referencedRecordSemantics).toBe(capabilities.referencedRecordSemantics);
			expect(descriptor.markdown).toBe(capabilities.markdown);
		}
	});
});
