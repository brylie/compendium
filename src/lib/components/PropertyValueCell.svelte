<script lang="ts">
	import type { PropertyDefinition, PropertyValue } from '$lib/data/types';

	let {
		property,
		value,
		oninput,
		onAddOption,
		compact = false
	}: {
		property: PropertyDefinition;
		value: PropertyValue | undefined;
		oninput: (value: PropertyValue) => void;
		onAddOption?: () => void;
		compact?: boolean;
	} = $props();

	const fieldClass = $derived(
		compact
			? 'w-full rounded border-0 bg-transparent px-1.5 py-0.5 text-xs text-fg focus:bg-bg focus:ring-1 focus:ring-accent'
			: 'w-full rounded border-0 bg-transparent px-2 py-1 text-sm text-fg focus:bg-bg focus:ring-1 focus:ring-accent'
	);
</script>

{#if property.type === 'text'}
	<input
		type="text"
		value={(value as { value?: string })?.value ?? ''}
		onchange={(e) => oninput({ type: 'text', value: (e.target as HTMLInputElement).value })}
		class={fieldClass}
	/>
{:else if property.type === 'number'}
	<input
		type="number"
		value={(value as { value?: number })?.value ?? ''}
		onchange={(e) =>
			oninput({ type: 'number', value: Number((e.target as HTMLInputElement).value) })}
		class={fieldClass}
	/>
{:else if property.type === 'date'}
	<input
		type="date"
		value={(value as { value?: string })?.value ?? ''}
		onchange={(e) => oninput({ type: 'date', value: (e.target as HTMLInputElement).value })}
		class={fieldClass}
	/>
{:else if property.type === 'checkbox'}
	<div class="flex items-center justify-center py-1">
		<input
			type="checkbox"
			checked={(value as { value?: boolean })?.value ?? false}
			onchange={(e) => oninput({ type: 'checkbox', value: (e.target as HTMLInputElement).checked })}
			class="h-4 w-4 rounded border-border text-accent focus:ring-accent"
		/>
	</div>
{:else if property.type === 'select'}
	<div class="flex items-center gap-1">
		<select
			value={(value as { value?: string })?.value ?? ''}
			onchange={(e) => oninput({ type: 'select', value: (e.target as HTMLSelectElement).value })}
			class="{fieldClass} flex-1"
		>
			<option value="">—</option>
			{#each property.options ?? [] as option (option.id)}
				<option value={option.id}>{option.label}</option>
			{/each}
		</select>
		{#if onAddOption}
			<button
				type="button"
				onclick={onAddOption}
				class="rounded p-1 text-xs text-muted hover:text-accent"
				title="Add option"
			>
				+
			</button>
		{/if}
	</div>
{:else if property.type === 'relation'}
	<input
		type="text"
		placeholder="record ids…"
		value={(value as { value?: string[] })?.value?.join(', ') ?? ''}
		onchange={(e) =>
			oninput({
				type: 'relation',
				value: (e.target as HTMLInputElement).value
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			})}
		class={fieldClass}
	/>
{/if}
