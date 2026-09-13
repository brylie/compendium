import { BLOCK_CAPABILITIES, type BlockFieldContract } from '$lib/data/block-capabilities';
import { blockTypes, type BlockType } from '$lib/data/types';

/**
 * The `list_block_types` response shape's own compatibility contract (issue
 * #29's "version or otherwise evolve the contract compatibly" checklist
 * item) — separate from the MCP server's own `packageJson.version`
 * (`mcp/server.ts`), which tracks the whole tool surface, not this one
 * tool's payload shape. Bump this only for a breaking change to an existing
 * field's name or meaning; adding a new block type or a new optional field
 * is additive and does not require a bump. See `mcp-tools.md`'s
 * `list_block_types` row.
 */
export const BLOCK_TYPE_SCHEMA_VERSION = 1;

export interface BlockTypeDescriptor {
	blockType: BlockType;
	label: string;
	description: string;
	capabilities: {
		isContainer: boolean;
		childBlockTypes?: readonly BlockType[];
		holdsFreeformText: boolean;
	};
	fields: BlockFieldContract;
	referencedRecordSemantics?: string;
	markdown: {
		writable: boolean;
		representation: string;
	};
}

export interface ListBlockTypesResult {
	schemaVersion: number;
	blockTypes: BlockTypeDescriptor[];
}

/**
 * Read-only MCP discovery surface (issue #29): every currently enabled
 * `BlockType` with its label/description, capability flags, and the
 * create_record/write_record field contract an agent needs to construct a
 * correct request for it — all read from `BLOCK_CAPABILITIES`
 * (`$lib/data/block-capabilities.ts`), the same table `SlashMenu.svelte`'s
 * command list and every runtime capability check already share, so this
 * tool cannot drift from either. No permission scoping applies — block-type
 * metadata isn't workspace content, so every caller with a valid token sees
 * the same result (`mcp/server.ts` still requires a valid token to call any
 * tool, including this one, for uniform authentication).
 */
export function listBlockTypes(): ListBlockTypesResult {
	return {
		schemaVersion: BLOCK_TYPE_SCHEMA_VERSION,
		blockTypes: blockTypes.map((blockType) => {
			const capabilities = BLOCK_CAPABILITIES[blockType];
			return {
				blockType,
				label: capabilities.label,
				description: capabilities.description,
				capabilities: {
					isContainer: capabilities.isContainer,
					childBlockTypes: capabilities.childBlockTypes,
					holdsFreeformText: capabilities.holdsFreeformText
				},
				fields: capabilities.fields,
				referencedRecordSemantics: capabilities.referencedRecordSemantics,
				markdown: capabilities.markdown
			};
		})
	};
}
