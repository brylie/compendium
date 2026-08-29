<script lang="ts">
	import { tick } from 'svelte';

	let {
		open,
		title,
		label,
		placeholder = '',
		initialValue = '',
		errorMessage = '',
		submitLabel = 'Save',
		onSubmit,
		onCancel
	}: {
		open: boolean;
		title: string;
		label: string;
		placeholder?: string;
		initialValue?: string;
		errorMessage?: string;
		submitLabel?: string;
		onSubmit: (value: string) => void;
		onCancel: () => void;
	} = $props();

	let input: HTMLInputElement | undefined = $state();
	let dialog: HTMLDivElement | undefined = $state();
	let value = $state('');

	$effect(() => {
		if (!open) return;
		const previousFocus =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		value = initialValue;
		void tick().then(() => input?.focus());
		return () => previousFocus?.focus();
	});

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		onSubmit(value);
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			onCancel();
			return;
		}
		if (event.key !== 'Tab' || !dialog) return;
		const focusable = Array.from(
			dialog.querySelectorAll<HTMLElement>(
				'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]'
			)
		);
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
			aria-labelledby="prompt-dialog-title"
			tabindex="-1"
			class="w-full max-w-md rounded-lg border border-border bg-bg p-5 shadow-xl"
			onkeydown={handleKeydown}
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
				{#if errorMessage}
					<p class="mt-2 text-sm text-red-700" role="alert">{errorMessage}</p>
				{/if}
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
