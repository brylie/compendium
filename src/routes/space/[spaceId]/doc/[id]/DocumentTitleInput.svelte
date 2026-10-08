<script lang="ts">
	let {
		title = $bindable(''),
		onTitleChange,
		onNavigateNext,
		placeholder = 'Untitled document'
	}: {
		title: string;
		onTitleChange?: (newTitle: string) => void;
		onNavigateNext: () => void | Promise<void>;
		placeholder?: string;
	} = $props();

	function handleTitleInput(event: Event): void {
		title = (event.target as HTMLInputElement).value;
		onTitleChange?.(title);
	}

	async function handleTitleKeydown(e: KeyboardEvent): Promise<void> {
		if (e.key === 'Enter' || e.key === 'ArrowDown') {
			e.preventDefault();
			await onNavigateNext();
		}
	}
</script>

<!-- Document Title -->
<input
	class="w-full border-none bg-transparent font-display text-3xl font-semibold tracking-tight text-fg outline-none placeholder:text-muted/50 focus:ring-0 md:text-4xl"
	value={title}
	oninput={handleTitleInput}
	onkeydown={handleTitleKeydown}
	{placeholder}
/>
