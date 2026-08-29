<script lang="ts">
	import { tick } from 'svelte';

	let {
		open,
		title,
		message,
		confirmLabel = 'Confirm',
		onConfirm,
		onCancel
	}: {
		open: boolean;
		title: string;
		message: string;
		confirmLabel?: string;
		onConfirm: () => void;
		onCancel: () => void;
	} = $props();

	let confirmButton: HTMLButtonElement | undefined = $state();
	$effect(() => {
		if (open) void tick().then(() => confirmButton?.focus());
	});
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
		role="presentation"
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="confirm-dialog-title"
			tabindex="-1"
			class="w-full max-w-md rounded-lg border border-border bg-bg p-5 shadow-xl"
			onkeydown={(event) => {
				if (event.key === 'Escape') onCancel();
			}}
		>
			<h2 id="confirm-dialog-title" class="text-lg font-semibold text-fg">{title}</h2>
			<p class="mt-2 text-sm text-muted">{message}</p>
			<div class="mt-5 flex justify-end gap-2">
				<button
					type="button"
					onclick={onCancel}
					class="rounded px-3 py-2 text-sm text-muted hover:text-fg">Cancel</button
				>
				<button
					bind:this={confirmButton}
					type="button"
					onclick={onConfirm}
					class="rounded bg-red-600 px-3 py-2 text-sm font-medium text-white">{confirmLabel}</button
				>
			</div>
		</div>
	</div>
{/if}
