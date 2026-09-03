<script lang="ts">
	import type * as Y from 'yjs';
	import type { WorkspaceRecord } from '$lib/data/types';
	import CalloutBlock from './CalloutBlock.svelte';

	let { block, ydoc }: { block: WorkspaceRecord; ydoc: Y.Doc } = $props();
</script>

<CalloutBlock {block} {ydoc}>Callout text</CalloutBlock>
