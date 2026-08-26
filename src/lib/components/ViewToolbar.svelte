<script lang="ts">
	import type { PropertyDefinition } from '$lib/data/types';
	import type { ViewConfig, ViewFilter, ViewFilterOp, SortDirection } from '$lib/data/views';
	import Icon from './Icon.svelte';

	let {
		schema,
		config = $bindable()
	}: {
		schema: PropertyDefinition[];
		config: ViewConfig;
	} = $props();

	const FILTER_OPS: { value: ViewFilterOp; label: string }[] = [
		{ value: 'is', label: 'is' },
		{ value: 'is_not', label: 'is not' },
		{ value: 'is_empty', label: 'is empty' },
		{ value: 'is_not_empty', label: 'is not empty' }
	];

	function propertyByKey(key: string): PropertyDefinition | undefined {
		return schema.find((p) => p.key === key);
	}

	function addFilter(): void {
		const first = schema[0];
		if (!first) return;
		config.filters = [...(config.filters ?? []), { propertyKey: first.key, op: 'is' }];
	}

	function removeFilter(index: number): void {
		config.filters = (config.filters ?? []).filter((_, i) => i !== index);
	}

	function updateFilter(index: number, patch: Partial<ViewFilter>): void {
		config.filters = (config.filters ?? []).map((f, i) => (i === index ? { ...f, ...patch } : f));
	}

	function setSortMode(mode: 'manual' | 'property'): void {
		if (mode === 'manual') {
			config.sort = { mode: 'manual' };
		} else {
			config.sort = { mode: 'property', propertyKey: schema[0]?.key, direction: 'asc' };
		}
	}

	function toggleVisible(key: string): void {
		const current = config.visibleProperties ?? schema.map((p) => p.key);
		config.visibleProperties = current.includes(key)
			? current.filter((k) => k !== key)
			: [...current, key];
	}

	let visiblePanelOpen = $state(false);
	let filterPanelOpen = $state(false);
</script>

<div class="mb-4 flex flex-wrap items-center gap-2 text-xs">
	<!-- Filters -->
	<div class="relative">
		<button
			type="button"
			onclick={() => (filterPanelOpen = !filterPanelOpen)}
			class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-muted transition-colors hover:border-accent hover:text-accent"
			class:border-accent={(config.filters?.length ?? 0) > 0}
			class:text-accent={(config.filters?.length ?? 0) > 0}
		>
			<Icon name="filter" size={13} />
			<span>Filter{config.filters?.length ? ` (${config.filters.length})` : ''}</span>
		</button>
		{#if filterPanelOpen}
			<div
				class="absolute top-full left-0 z-10 mt-1 w-80 space-y-2 rounded-md border border-border bg-bg p-3 shadow-md"
			>
				{#each config.filters ?? [] as filter, index (index)}
					<div class="flex items-center gap-1.5">
						<select
							value={filter.propertyKey}
							onchange={(e) =>
								updateFilter(index, { propertyKey: (e.target as HTMLSelectElement).value })}
							class="flex-1 rounded border border-border bg-bg px-1.5 py-1 text-xs"
						>
							{#each schema as property (property.key)}
								<option value={property.key}>{property.label}</option>
							{/each}
						</select>
						<select
							value={filter.op}
							onchange={(e) =>
								updateFilter(index, { op: (e.target as HTMLSelectElement).value as ViewFilterOp })}
							class="rounded border border-border bg-bg px-1.5 py-1 text-xs"
						>
							{#each FILTER_OPS as op (op.value)}
								<option value={op.value}>{op.label}</option>
							{/each}
						</select>
						{#if filter.op === 'is' || filter.op === 'is_not'}
							{@const property = propertyByKey(filter.propertyKey)}
							{#if property?.type === 'select'}
								<select
									value={filter.value ?? ''}
									onchange={(e) =>
										updateFilter(index, { value: (e.target as HTMLSelectElement).value })}
									class="w-24 rounded border border-border bg-bg px-1.5 py-1 text-xs"
								>
									<option value="">—</option>
									{#each property.options ?? [] as option (option.id)}
										<option value={option.id}>{option.label}</option>
									{/each}
								</select>
							{:else}
								<input
									type="text"
									value={filter.value ?? ''}
									oninput={(e) =>
										updateFilter(index, { value: (e.target as HTMLInputElement).value })}
									class="w-24 rounded border border-border bg-bg px-1.5 py-1 text-xs"
								/>
							{/if}
						{/if}
						<button
							type="button"
							onclick={() => removeFilter(index)}
							class="p-0.5 text-muted hover:text-red-500"
							aria-label="Remove filter"
						>
							×
						</button>
					</div>
				{:else}
					<p class="text-muted italic">No filters yet.</p>
				{/each}
				<button
					type="button"
					onclick={addFilter}
					class="text-accent hover:underline"
					disabled={schema.length === 0}
				>
					+ Add filter
				</button>
			</div>
		{/if}
	</div>

	<!-- Sort -->
	<div class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-muted">
		<Icon name="sort" size={13} />
		<select
			value={config.sort?.mode ?? 'manual'}
			onchange={(e) => setSortMode((e.target as HTMLSelectElement).value as 'manual' | 'property')}
			class="bg-transparent text-xs"
		>
			<option value="manual">Manual order</option>
			<option value="property">Sort by property</option>
		</select>
		{#if config.sort?.mode === 'property'}
			<select
				value={config.sort.propertyKey}
				onchange={(e) => {
					if (config.sort) config.sort.propertyKey = (e.target as HTMLSelectElement).value;
				}}
				class="rounded border border-border bg-bg px-1.5 py-1 text-xs"
			>
				{#each schema as property (property.key)}
					<option value={property.key}>{property.label}</option>
				{/each}
			</select>
			<select
				value={config.sort.direction ?? 'asc'}
				onchange={(e) => {
					if (config.sort)
						config.sort.direction = (e.target as HTMLSelectElement).value as SortDirection;
				}}
				class="rounded border border-border bg-bg px-1.5 py-1 text-xs"
			>
				<option value="asc">Ascending</option>
				<option value="desc">Descending</option>
			</select>
		{/if}
	</div>

	<!-- Visible properties -->
	<div class="relative">
		<button
			type="button"
			onclick={() => (visiblePanelOpen = !visiblePanelOpen)}
			class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-muted transition-colors hover:border-accent hover:text-accent"
		>
			<span>Fields</span>
		</button>
		{#if visiblePanelOpen}
			<div
				class="absolute top-full left-0 z-10 mt-1 w-56 space-y-1 rounded-md border border-border bg-bg p-2 shadow-md"
			>
				{#each schema as property (property.key)}
					{@const isVisible = (config.visibleProperties ?? schema.map((p) => p.key)).includes(
						property.key
					)}
					<label class="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-surface">
						<input
							type="checkbox"
							checked={isVisible}
							onchange={() => toggleVisible(property.key)}
							class="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent"
						/>
						<span>{property.label}</span>
					</label>
				{/each}
			</div>
		{/if}
	</div>
</div>
