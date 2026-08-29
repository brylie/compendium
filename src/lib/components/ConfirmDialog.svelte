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

	let cancelButton: HTMLButtonElement | undefined = $state();
	let dialog: HTMLDivElement | undefined = $state();
	$effect(() => {
		if (!open) return;
		const previousFocus =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		void tick().then(() => cancelButton?.focus());
		return () => previousFocus?.focus();
	});

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			onCancel();
			return;
		}
		if (event.key !== 'Tab' || !dialog) return;
		const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled])'));
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) return;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
		role="presentation"
	>
		<div
			bind:this={dialog}
			role="dialog"
			aria-modal="true"
			aria-labelledby="confirm-dialog-title"
			tabindex="-1"
			class="w-full max-w-md rounded-lg border border-border bg-bg p-5 shadow-xl"
			onkeydown={handleKeydown}
		>
			<h2 id="confirm-dialog-title" class="text-lg font-semibold text-fg">{title}</h2>
			<p class="mt-2 text-sm text-muted">{message}</p>
			<div class="mt-5 flex justify-end gap-2">
				<button
					bind:this={cancelButton}
					type="button"
					onclick={onCancel}
					class="rounded px-3 py-2 text-sm text-muted hover:text-fg">Cancel</button
				>
				<button
					type="button"
					onclick={onConfirm}
					class="rounded bg-red-600 px-3 py-2 text-sm font-medium text-white">{confirmLabel}</button
				>
			</div>
		</div>
	</div>
{/if}
