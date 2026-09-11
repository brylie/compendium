import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'svelte';
import type { Backlink } from '$lib/data/links';
import SyncedBlockUsage from './SyncedBlockUsage.svelte';

function instance(overrides: Partial<Backlink> = {}): Backlink {
	return {
		sourceDocumentId: 'doc-source',
		sourceDocumentTitle: 'Source Doc',
		sourceRecordId: 'block-1',
		context: 'Some context text',
		...overrides
	};
}

function baseProps(
	overrides: Partial<ComponentProps<typeof SyncedBlockUsage>> = {}
): ComponentProps<typeof SyncedBlockUsage> {
	return {
		spaceId: 'space-1',
		currentDocumentId: 'doc-current',
		instances: [instance()],
		onJumpTo: vi.fn(),
		...overrides
	};
}

// This is the one live surface using the navigate-to-`#block-<id>`-and-reveal
// mechanism issue #83 asks for — the general page_link/wiki-link Backlinks
// panel that issue describes was removed (#120) pending a shard-aware
// reverse index (#81/#70), so this is where that navigation contract is
// actually exercised today.
describe('SyncedBlockUsage (#153, #83)', () => {
	it('lists each usage as a real link to its exact source-block fragment', async () => {
		const user = userEvent.setup();
		render(SyncedBlockUsage, baseProps());

		await user.click(screen.getByRole('button', { name: 'Used in 1 place' }));

		const link = screen.getByRole('menuitem', { name: /Source Doc/ });
		expect(link).toHaveAttribute('href', expect.stringContaining('/space/space-1/doc/doc-source'));
		expect(link.getAttribute('href')).toMatch(/#block-block-1$/);
	});

	it('jumps in place and suppresses navigation when the usage is in the current document', async () => {
		const user = userEvent.setup();
		const props = baseProps({
			currentDocumentId: 'doc-source',
			instances: [instance({ sourceDocumentId: 'doc-source' })]
		});
		render(SyncedBlockUsage, props);

		await user.click(screen.getByRole('button', { name: 'Used in 1 place' }));
		await user.click(screen.getByRole('menuitem', { name: /Source Doc/ }));

		expect(props.onJumpTo).toHaveBeenCalledExactlyOnceWith('doc-source', 'block-1');
	});

	// A real <a href> (not a JS-only handler) for a cross-document usage is
	// what keeps browser Back and keyboard Enter/Space activation working for
	// free — asserting onJumpTo is never called here is how this test proves
	// the click was left to normal navigation instead of being intercepted.
	it('does not intercept navigation when the usage is in a different document', async () => {
		const user = userEvent.setup();
		const props = baseProps({
			currentDocumentId: 'doc-current',
			instances: [instance({ sourceDocumentId: 'doc-other' })]
		});
		render(SyncedBlockUsage, props);

		await user.click(screen.getByRole('button', { name: 'Used in 1 place' }));
		await user.click(screen.getByRole('menuitem', { name: /Source Doc/ }));

		expect(props.onJumpTo).not.toHaveBeenCalled();
	});

	it('shows a placeholder instead of a link list when there are no other usages', async () => {
		const user = userEvent.setup();
		render(SyncedBlockUsage, baseProps({ instances: [] }));

		await user.click(screen.getByRole('button', { name: 'Used in 0 places' }));

		expect(screen.getByText('No other locations yet.')).toBeInTheDocument();
		expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
	});

	it('closes on Escape', async () => {
		const user = userEvent.setup();
		render(SyncedBlockUsage, baseProps());

		await user.click(screen.getByRole('button', { name: 'Used in 1 place' }));
		expect(screen.getByRole('menu')).toBeInTheDocument();

		await user.keyboard('{Escape}');
		expect(screen.queryByRole('menu')).not.toBeInTheDocument();
	});

	it('ArrowDown/ArrowUp move roving focus among usage links, wrapping at each end', async () => {
		const user = userEvent.setup();
		const props = baseProps({
			instances: [
				instance({ sourceRecordId: 'block-1', sourceDocumentTitle: 'First Doc' }),
				instance({ sourceRecordId: 'block-2', sourceDocumentTitle: 'Second Doc' })
			]
		});
		render(SyncedBlockUsage, props);

		await user.click(screen.getByRole('button', { name: 'Used in 2 places' }));
		const first = screen.getByRole('menuitem', { name: /First Doc/ });
		const second = screen.getByRole('menuitem', { name: /Second Doc/ });
		expect(first).toHaveFocus();

		await user.keyboard('{ArrowDown}');
		expect(second).toHaveFocus();

		await user.keyboard('{ArrowDown}');
		expect(first).toHaveFocus();

		await user.keyboard('{ArrowUp}');
		expect(second).toHaveFocus();
	});

	it('offers Detach only when onDetach is provided, and calls it', async () => {
		const user = userEvent.setup();
		const props = baseProps({ onDetach: vi.fn() });
		render(SyncedBlockUsage, props);

		await user.click(screen.getByRole('button', { name: 'Used in 1 place' }));
		await user.click(screen.getByRole('menuitem', { name: 'Detach to independent copy' }));

		expect(props.onDetach).toHaveBeenCalledOnce();
	});

	it('does not offer Detach when onDetach is absent', async () => {
		const user = userEvent.setup();
		render(SyncedBlockUsage, baseProps());

		await user.click(screen.getByRole('button', { name: 'Used in 1 place' }));

		expect(screen.queryByRole('menuitem', { name: 'Detach to independent copy' })).toBeNull();
	});
});
