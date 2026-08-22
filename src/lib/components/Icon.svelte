<script lang="ts">
	let {
		name,
		size = 18,
		class: className = ''
	}: {
		name:
			| 'document'
			| 'chevron-right'
			| 'chevron-down'
			| 'chevron-left'
			| 'table'
			| 'callout'
			| 'toggle'
			| 'code'
			| 'divider'
			| 'quote'
			| 'check'
			| 'checkbox'
			| 'checkbox-checked'
			| 'toc'
			| 'sync'
			| 'plus'
			| 'trash'
			| 'sun'
			| 'moon'
			| 'key'
			| 'history'
			| 'sidebar'
			| 'dots'
			| 'link'
			| 'heading-1'
			| 'heading-2'
			| 'heading-3'
			| 'heading-4'
			| 'list-bullet'
			| 'list-number'
			| 'logo';
		size?: number;
		class?: string;
	} = $props();
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	viewBox="0 0 20 20"
	width={size}
	height={size}
	fill="none"
	stroke="currentColor"
	stroke-width="1.6"
	stroke-linecap="round"
	stroke-linejoin="round"
	class={className}
	aria-hidden="true"
>
	{#if name === 'document'}
		<path
			d="M4 3.5A1.5 1.5 0 0 1 5.5 2h6l4.5 4.5v10a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 16.5v-13Z"
		/>
		<path d="M11.5 2v4.5H16" />
	{:else if name === 'chevron-right'}
		<path d="m7.5 5 5 5-5 5" />
	{:else if name === 'chevron-down'}
		<path d="m5 7.5 5 5 5-5" />
	{:else if name === 'chevron-left'}
		<path d="m12.5 15-5-5 5-5" />
	{:else if name === 'table'}
		<rect x="3" y="3.5" width="14" height="13" rx="1.5" />
		<path d="M3 8h14M8 8v8.5" />
	{:else if name === 'callout'}
		<path d="M10 2a8 8 0 1 0 8 8 8 8 0 0 0-8-8Zm0 4.5v3.5m0 3.5h.01" />
	{:else if name === 'toggle'}
		<path d="m6 8 4 4 4-4" />
	{:else if name === 'code'}
		<path d="m7 6.5-4.5 3.5 4.5 3.5M13 6.5l4.5 3.5-4.5 3.5" />
	{:else if name === 'divider'}
		<path d="M3 10h14" stroke-dasharray="2 3" />
	{:else if name === 'quote'}
		<path d="M3.5 8h3.5v4h-2a2 2 0 0 0 2 2M10.5 8h3.5v4h-2a2 2 0 0 0 2 2" />
	{:else if name === 'check'}
		<path d="m4.5 10.5 3.5 3.5 7.5-8" />
	{:else if name === 'checkbox'}
		<rect x="3.5" y="3.5" width="13" height="13" rx="3" />
	{:else if name === 'checkbox-checked'}
		<rect x="3.5" y="3.5" width="13" height="13" rx="3" fill="currentColor" />
		<path d="m6.5 10 2.5 2.5 4.5-5" stroke="var(--color-accent-fg)" stroke-width="1.8" />
	{:else if name === 'toc'}
		<path d="M3.5 5h13M3.5 9h9M3.5 13h11M3.5 17h7" />
	{:else if name === 'sync'}
		<path d="M17 3v4.5H12.5M3 17v-4.5H7.5" />
		<path d="M17 7.5A7 7 0 0 0 4.5 9M3 12.5a7 7 0 0 0 12.5 1.5" />
	{:else if name === 'plus'}
		<path d="M10 4v12M4 10h12" />
	{:else if name === 'trash'}
		<path
			d="M3.5 5.5h13M7.5 5.5V3.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M5.5 5.5v10a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5v-10"
		/>
	{:else if name === 'sun'}
		<circle cx="10" cy="10" r="3.5" />
		<path
			d="M10 2v2M10 16v2M2 10h2M16 10h2M4.34 4.34l1.42 1.42M14.24 14.24l1.42 1.42M4.34 15.66l1.42-1.42M14.24 5.76l1.42-1.42"
		/>
	{:else if name === 'moon'}
		<path d="M16.5 12.8A7 7 0 1 1 7.2 3.5a5.5 5.5 0 0 0 9.3 9.3Z" />
	{:else if name === 'key'}
		<circle cx="7.5" cy="12.5" r="4" />
		<path d="m10.5 9.5 6-6M15 3.5l1.5 1.5M13 5.5l1.5 1.5" />
	{:else if name === 'history'}
		<path d="M3 10a7 7 0 1 1 2 5M3 15v-5h5" />
		<path d="M10 6v4.5l3 1.5" />
	{:else if name === 'sidebar'}
		<rect x="3" y="3.5" width="14" height="13" rx="1.5" />
		<path d="M7.5 3.5V16.5" />
	{:else if name === 'dots'}
		<circle cx="5" cy="10" r="1" fill="currentColor" />
		<circle cx="10" cy="10" r="1" fill="currentColor" />
		<circle cx="15" cy="10" r="1" fill="currentColor" />
	{:else if name === 'link'}
		<path d="M8.5 12.5a3.5 3.5 0 0 0 5 0l2-2a3.5 3.5 0 0 0-5-5l-1 1" />
		<path d="M11.5 7.5a3.5 3.5 0 0 0-5 0l-2 2a3.5 3.5 0 0 0 5 5l1-1" />
	{:else if name === 'heading-1'}
		<path d="M3.5 5v10M10.5 5v10M3.5 10h7M14 8l2-2v9" />
	{:else if name === 'heading-2'}
		<path d="M3.5 5v10M9.5 5v10M3.5 10h6M13.5 7a2 2 0 0 1 3 1.5c0 1.5-2.5 3-2.5 4.5h3.5" />
	{:else if name === 'heading-3'}
		<path d="M3.5 5v10M9.5 5v10M3.5 10h6M13.5 6.5h3l-1.5 2.5a1.8 1.8 0 1 1-1 3.2" />
	{:else if name === 'heading-4'}
		<path d="M3.5 5v10M9.5 5v10M3.5 10h6M16 13V6l-3.5 4.5h4" />
	{:else if name === 'list-bullet'}
		<circle cx="4.5" cy="6" r="1.2" fill="currentColor" />
		<circle cx="4.5" cy="10" r="1.2" fill="currentColor" />
		<circle cx="4.5" cy="14" r="1.2" fill="currentColor" />
		<path d="M8.5 6h8M8.5 10h8M8.5 14h8" />
	{:else if name === 'list-number'}
		<path
			d="M4 6.5 5 5v3.5M3.5 11.5a1.2 1.2 0 0 1 2 0c0 .8-1.5 1.5-1.5 2.2h2M8.5 6h8M8.5 10h8M8.5 14h8"
		/>
	{:else if name === 'logo'}
		<path d="M4 5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Z" />
		<path d="M7 7.5h6M7 11h4M7 14.5h5" />
	{/if}
</svg>
