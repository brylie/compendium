import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createDocument } from '$lib/data/document-ops';
import { createRecord, getRecord } from '$lib/data/record-ops';
import type { ActorId } from '$lib/data/types';
import CalloutBlockHarness from './CalloutBlockHarness.svelte';

const actor: ActorId = { kind: 'human', userId: 'local' };

describe('CalloutBlock (issue #42)', () => {
	it('renders the neutral default appearance for a callout with no style set', () => {
		const ydoc = new Y.Doc();
		const document = createDocument(ydoc, { title: 'Notes' });
		const block = createRecord(ydoc, { parentId: document.id, blockType: 'callout' }, actor);

		render(CalloutBlockHarness, { block, ydoc });

		expect(screen.getByText('Callout text')).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: 'Callout style for this callout' })
		).toBeInTheDocument();
	});

	it("renders a preset's own icon and label in the style picker", async () => {
		const ydoc = new Y.Doc();
		const document = createDocument(ydoc, { title: 'Notes' });
		const block = createRecord(
			ydoc,
			{
				parentId: document.id,
				blockType: 'callout',
				calloutStyle: { kind: 'preset', preset: 'danger' }
			},
			actor
		);

		render(CalloutBlockHarness, { block, ydoc });

		expect(screen.getByRole('button', { name: 'Callout style for Danger' })).toBeInTheDocument();
	});

	it('choosing a preset from the picker persists it to the record', async () => {
		const ydoc = new Y.Doc();
		const document = createDocument(ydoc, { title: 'Notes' });
		const block = createRecord(ydoc, { parentId: document.id, blockType: 'callout' }, actor);
		const user = userEvent.setup();

		render(CalloutBlockHarness, { block, ydoc });

		await user.click(screen.getByRole('button', { name: 'Callout style for this callout' }));
		await user.click(screen.getByRole('menuitem', { name: 'Tip' }));

		expect(getRecord(ydoc, block.id)?.calloutStyle).toEqual({ kind: 'preset', preset: 'tip' });
	});

	it('applying a custom icon+color persists it to the record', async () => {
		const ydoc = new Y.Doc();
		const document = createDocument(ydoc, { title: 'Notes' });
		const block = createRecord(ydoc, { parentId: document.id, blockType: 'callout' }, actor);
		const user = userEvent.setup();

		render(CalloutBlockHarness, { block, ydoc });

		await user.click(screen.getByRole('button', { name: 'Callout style for this callout' }));
		await user.selectOptions(screen.getByLabelText('Icon'), 'warning');
		const colorInput = screen.getByLabelText('Color') as HTMLInputElement;
		// A native <input type="color"> isn't a typeable/clearable text field
		// (userEvent.type/.clear both refuse it) — its value is set directly
		// via a change event instead, matching how a real color picker
		// commits a choice.
		await fireEvent.input(colorInput, { target: { value: '#ff8800' } });
		await user.click(screen.getByRole('button', { name: 'Apply' }));

		expect(getRecord(ydoc, block.id)?.calloutStyle).toEqual({
			kind: 'custom',
			icon: 'warning',
			color: '#ff8800'
		});
	});

	it('"Reset to default" clears a set style back to undefined', async () => {
		const ydoc = new Y.Doc();
		const document = createDocument(ydoc, { title: 'Notes' });
		const block = createRecord(
			ydoc,
			{
				parentId: document.id,
				blockType: 'callout',
				calloutStyle: { kind: 'preset', preset: 'note' }
			},
			actor
		);
		const user = userEvent.setup();

		render(CalloutBlockHarness, { block, ydoc });

		await user.click(screen.getByRole('button', { name: 'Callout style for Note' }));
		await user.click(screen.getByRole('menuitem', { name: 'Reset to default' }));

		expect(getRecord(ydoc, block.id)?.calloutStyle).toBeUndefined();
	});

	it('closes the style menu on Escape even though focus stays on the trigger button', async () => {
		const ydoc = new Y.Doc();
		const document = createDocument(ydoc, { title: 'Notes' });
		const block = createRecord(ydoc, { parentId: document.id, blockType: 'callout' }, actor);
		const user = userEvent.setup();

		render(CalloutBlockHarness, { block, ydoc });

		await user.click(screen.getByRole('button', { name: 'Callout style for this callout' }));
		expect(screen.getByRole('menu', { name: 'Callout style' })).toBeInTheDocument();

		await user.keyboard('{Escape}');
		expect(screen.queryByRole('menu', { name: 'Callout style' })).not.toBeInTheDocument();
	});

	it('does not offer "Reset to default" when the callout has no style set yet', async () => {
		const ydoc = new Y.Doc();
		const document = createDocument(ydoc, { title: 'Notes' });
		const block = createRecord(ydoc, { parentId: document.id, blockType: 'callout' }, actor);
		const user = userEvent.setup();

		render(CalloutBlockHarness, { block, ydoc });

		await user.click(screen.getByRole('button', { name: 'Callout style for this callout' }));

		expect(screen.queryByRole('menuitem', { name: 'Reset to default' })).not.toBeInTheDocument();
	});
});
