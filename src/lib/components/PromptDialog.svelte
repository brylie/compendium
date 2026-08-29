<script lang="ts">
	import { tick } from 'svelte';

	let {
		open,
		title,
		label,
		placeholder = '',
		initialValue = '',
		submitLabel = 'Save',
		onSubmit,
		onCancel
	}: {
		open: boolean;
		title: string;
		label: string;
		placeholder?: string;
		initialValue?: string;
		submitLabel?: string;
		onSubmit: (value: string) => void;
		onCancel: () => void;
	} = $props();

	let input: HTMLInputElement | undefined = $state();
	let value = $state('');

	$effect(() => {
		if (!open) return;
		value = initialValue;
		void tick().then(() => input?.focus());
	});

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		onSubmit(value);
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
		role="presentation"
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="prompt-dialog-title"
			tabindex="-1"
			class="w-full max-w-md rounded-lg border border-border bg-bg p-5 shadow-xl"
			onkeydown={(event) => {
				if (event.key === 'Escape') onCancel();
			}}
		>
			<form onsubmit={submit}>
				<h2 id="prompt-dialog-title" class="text-lg font-semibold text-fg">{title}</h2>
				<label class="mt-4 block text-sm font-medium text-fg">
					{label}
					<input
						bind:this={input}
						bind:value
						class="mt-1.5 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
						{placeholder}
					/>
				</label>
				<div class="mt-5 flex justify-end gap-2">
					<button
						type="button"
						onclick={onCancel}
						class="rounded px-3 py-2 text-sm text-muted hover:text-fg">Cancel</button
					>
					<button
						type="submit"
						class="rounded bg-accent px-3 py-2 text-sm font-medium text-accent-fg"
						>{submitLabel}</button
					>
				</div>
			</form>
		</div>
	</div>
{/if}
