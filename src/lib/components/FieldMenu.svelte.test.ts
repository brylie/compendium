import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import {
	createCollection,
	createRecord,
	deleteCollection,
	getCollection,
	getRecord
} from '$lib/data/records';
import FieldMenu from './FieldMenu.svelte';

let ydoc: Y.Doc;
vi.mock('$lib/client/yjs-client', () => ({ getClientDoc: () => ydoc }));

const human = { kind: 'human' as const, userId: 'local' };

describe('FieldMenu', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
	});

	afterEach(() => {
		ydoc.destroy();
	});

	it('renames a field through the edit form', async () => {
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const user = userEvent.setup();
		render(FieldMenu, {
			collectionId: collection.id,
			schema: collection.schema,
			property: collection.schema[0]
		});

		await user.click(screen.getByRole('button', { name: 'Field options for Name' }));
		await user.click(screen.getByRole('menuitem', { name: 'Edit field' }));
		const label = screen.getByLabelText('Label');
		await user.clear(label);
		await user.type(label, 'Full name');
		await user.click(screen.getByRole('button', { name: 'Save' }));

		expect(getCollection(ydoc, collection.id)?.schema[0].label).toBe('Full name');
	});

	it('warns before a retype that would clear values, and applies the migration on save', async () => {
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [{ key: 'qty', label: 'Qty', type: 'text' }]
		});
		const record = createRecord(
			ydoc,
			{ parentId: collection.id, properties: { qty: { type: 'text', value: 'not-a-number' } } },
			human
		);
		const user = userEvent.setup();
		render(FieldMenu, {
			collectionId: collection.id,
			schema: collection.schema,
			property: collection.schema[0]
		});

		await user.click(screen.getByRole('button', { name: 'Field options for Qty' }));
		await user.click(screen.getByRole('menuitem', { name: 'Edit field' }));
		await user.selectOptions(screen.getByLabelText('Type'), 'number');

		expect(screen.getByText(/will clear the value on 1 of 1/)).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Save' }));

		expect(getCollection(ydoc, collection.id)?.schema[0].type).toBe('number');
		expect(getRecord(ydoc, record.id)?.properties?.qty).toBeUndefined();
	});

	it('inserts a new field to the left', async () => {
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const user = userEvent.setup();
		render(FieldMenu, {
			collectionId: collection.id,
			schema: collection.schema,
			property: collection.schema[0]
		});

		await user.click(screen.getByRole('button', { name: 'Field options for Name' }));
		await user.click(screen.getByRole('menuitem', { name: 'Insert left' }));

		const schema = getCollection(ydoc, collection.id)?.schema ?? [];
		expect(schema.map((p) => p.label)).toEqual(['New field', 'Name']);
	});

	it('duplicates a field, copying its value', async () => {
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const record = createRecord(
			ydoc,
			{ parentId: collection.id, properties: { name: { type: 'text', value: 'Alice' } } },
			human
		);
		const user = userEvent.setup();
		render(FieldMenu, {
			collectionId: collection.id,
			schema: collection.schema,
			property: collection.schema[0]
		});

		await user.click(screen.getByRole('button', { name: 'Field options for Name' }));
		await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

		const schema = getCollection(ydoc, collection.id)?.schema ?? [];
		expect(schema.map((p) => p.label)).toEqual(['Name', 'Name copy']);
		expect(getRecord(ydoc, record.id)?.properties?.[schema[1].key]).toEqual({
			type: 'text',
			value: 'Alice'
		});
	});

	it('offers "Hide in this view" only when onToggleVisible is passed, and calls it', async () => {
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const onToggleVisible = vi.fn();
		const user = userEvent.setup();
		render(FieldMenu, {
			collectionId: collection.id,
			schema: collection.schema,
			property: collection.schema[0],
			visible: true,
			onToggleVisible
		});

		await user.click(screen.getByRole('button', { name: 'Field options for Name' }));
		expect(screen.getByRole('menuitem', { name: 'Hide in this view' })).toBeInTheDocument();
		await user.click(screen.getByRole('menuitem', { name: 'Hide in this view' }));

		expect(onToggleVisible).toHaveBeenCalledOnce();
	});

	it('omits the visibility toggle when no onToggleVisible is passed', async () => {
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const user = userEvent.setup();
		render(FieldMenu, {
			collectionId: collection.id,
			schema: collection.schema,
			property: collection.schema[0]
		});

		await user.click(screen.getByRole('button', { name: 'Field options for Name' }));

		expect(screen.queryByRole('menuitem', { name: /in this view/ })).not.toBeInTheDocument();
	});

	it('deletes a field after confirming, showing the affected-record count', async () => {
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		createRecord(
			ydoc,
			{ parentId: collection.id, properties: { name: { type: 'text', value: 'Alice' } } },
			human
		);
		const user = userEvent.setup();
		render(FieldMenu, {
			collectionId: collection.id,
			schema: collection.schema,
			property: collection.schema[0]
		});

		await user.click(screen.getByRole('button', { name: 'Field options for Name' }));
		await user.click(screen.getByRole('menuitem', { name: 'Delete field' }));

		const dialog = screen.getByRole('dialog');
		expect(within(dialog).getByText(/1 record\(s\)/)).toBeInTheDocument();
		await user.click(within(dialog).getByRole('button', { name: 'Delete field' }));

		expect(getCollection(ydoc, collection.id)?.schema).toEqual([]);
	});

	it('cancelling the delete confirmation leaves the field intact', async () => {
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const user = userEvent.setup();
		render(FieldMenu, {
			collectionId: collection.id,
			schema: collection.schema,
			property: collection.schema[0]
		});

		await user.click(screen.getByRole('button', { name: 'Field options for Name' }));
		await user.click(screen.getByRole('menuitem', { name: 'Delete field' }));
		await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

		expect(getCollection(ydoc, collection.id)?.schema).toHaveLength(1);
	});

	it('navigates menu items with arrow keys', async () => {
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const user = userEvent.setup();
		render(FieldMenu, {
			collectionId: collection.id,
			schema: collection.schema,
			property: collection.schema[0],
			visible: true,
			onToggleVisible: vi.fn()
		});

		await user.click(screen.getByRole('button', { name: 'Field options for Name' }));
		expect(screen.getByRole('menuitem', { name: 'Edit field' })).toHaveFocus();

		await user.keyboard('{ArrowDown}');
		expect(screen.getByRole('menuitem', { name: 'Insert left' })).toHaveFocus();

		await user.keyboard('{ArrowUp}');
		expect(screen.getByRole('menuitem', { name: 'Edit field' })).toHaveFocus();
	});

	it('closes when clicking outside the menu', async () => {
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const user = userEvent.setup();
		render(FieldMenu, {
			collectionId: collection.id,
			schema: collection.schema,
			property: collection.schema[0]
		});

		await user.click(screen.getByRole('button', { name: 'Field options for Name' }));
		expect(screen.getByRole('menu')).toBeInTheDocument();

		await user.click(document.body);

		expect(screen.queryByRole('menu')).not.toBeInTheDocument();
	});

	describe('primary field (issue #96)', () => {
		function renderTwoTextFields() {
			return createCollection(ydoc, {
				title: 'T',
				schema: [
					{ key: 'name', label: 'Name', type: 'text' },
					{ key: 'notes', label: 'Notes', type: 'text' }
				]
			});
		}

		it('sets a field as primary from the menu', async () => {
			const collection = renderTwoTextFields();
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[1] // 'notes' — not the auto-fallback first text field
			});

			await user.click(screen.getByRole('button', { name: 'Field options for Notes' }));
			await user.click(screen.getByRole('menuitem', { name: 'Set as primary field' }));

			expect(getCollection(ydoc, collection.id)?.primaryFieldKey).toBe('notes');
		});

		it('offers "Set as primary field" (not "Unset") for the auto-fallback field, so it can be explicitly persisted', async () => {
			const collection = renderTwoTextFields();
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0] // 'name' — the resolved fallback with no explicit primaryFieldKey set
				// primaryFieldKey intentionally omitted — this is the auto-fallback case
			});

			await user.click(screen.getByRole('button', { name: 'Field options for Name' }));
			expect(screen.getByRole('menuitem', { name: 'Set as primary field' })).toBeInTheDocument();

			await user.click(screen.getByRole('menuitem', { name: 'Set as primary field' }));
			expect(getCollection(ydoc, collection.id)?.primaryFieldKey).toBe('name');
		});

		it('offers "Unset primary field" once a field is passed in as the current primary', async () => {
			const collection = renderTwoTextFields();
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[1],
				primaryFieldKey: 'notes'
			});

			await user.click(screen.getByRole('button', { name: 'Field options for Notes' }));
			expect(screen.getByRole('menuitem', { name: 'Unset primary field' })).toBeInTheDocument();
		});

		it('unsets an explicit primary field, reverting to the automatic fallback', async () => {
			const collection = renderTwoTextFields();
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[1],
				primaryFieldKey: 'notes'
			});

			await user.click(screen.getByRole('button', { name: 'Field options for Notes' }));
			await user.click(screen.getByRole('menuitem', { name: 'Unset primary field' }));

			expect(getCollection(ydoc, collection.id)?.primaryFieldKey).toBeUndefined();
		});

		it('disables the primary toggle for a relation field, which has no display value of its own', async () => {
			const collection = createCollection(ydoc, {
				title: 'T',
				schema: [{ key: 'links', label: 'Links', type: 'relation' }]
			});
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await user.click(screen.getByRole('button', { name: 'Field options for Links' }));

			expect(screen.getByRole('menuitem', { name: 'Set as primary field' })).toBeDisabled();
		});
	});

	describe('select field option lifecycle (issue #94)', () => {
		function renderSelectField() {
			const collection = createCollection(ydoc, {
				title: 'T',
				schema: [
					{
						key: 'status',
						label: 'Status',
						type: 'select',
						options: [
							{ id: 'todo', label: 'To do', color: 'oklch(60% 0.01 250)' },
							{ id: 'done', label: 'Done', color: 'oklch(65% 0.14 145)' }
						]
					}
				]
			});
			return { collection };
		}

		async function openOptionsEditor(user: ReturnType<typeof userEvent.setup>) {
			await user.click(screen.getByRole('button', { name: 'Field options for Status' }));
			await user.click(screen.getByRole('menuitem', { name: 'Edit field' }));
		}

		it('adds a new option through the inline add form', async () => {
			const { collection } = renderSelectField();
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await openOptionsEditor(user);
			await user.type(screen.getByLabelText('Add option'), 'Blocked');
			await user.click(screen.getByRole('button', { name: 'Add' }));

			const options = getCollection(ydoc, collection.id)?.schema[0].options ?? [];
			expect(options.map((o) => o.label)).toEqual(['To do', 'Done', 'Blocked']);
		});

		it('rejects adding a blank or already-used option label', async () => {
			const { collection } = renderSelectField();
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await openOptionsEditor(user);
			await user.type(screen.getByLabelText('Add option'), 'done');
			await user.click(screen.getByRole('button', { name: 'Add' }));

			expect(screen.getByText('An option named "done" already exists')).toBeInTheDocument();
			expect(getCollection(ydoc, collection.id)?.schema[0].options).toHaveLength(2);
		});

		it('renames an option by editing its label field', async () => {
			const { collection } = renderSelectField();
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await openOptionsEditor(user);
			const input = screen.getByLabelText('Rename option To do');
			await user.clear(input);
			await user.type(input, 'Backlog');
			fireEvent.blur(input);

			const options = getCollection(ydoc, collection.id)?.schema[0].options ?? [];
			expect(options[0].label).toBe('Backlog');
		});

		it('restores the input to the stored label when a rename is rejected as a duplicate', async () => {
			const { collection } = renderSelectField();
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await openOptionsEditor(user);
			const input = screen.getByLabelText<HTMLInputElement>('Rename option To do');
			await user.clear(input);
			await user.type(input, 'done');
			await fireEvent.blur(input);

			expect(await screen.findByText('An option named "done" already exists')).toBeInTheDocument();
			expect(input.value).toBe('To do');
			expect(getCollection(ydoc, collection.id)?.schema[0].options?.[0].label).toBe('To do');
		});

		it('recolors an option via the swatch picker', async () => {
			const { collection } = renderSelectField();
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await openOptionsEditor(user);
			await user.click(screen.getByRole('button', { name: 'Color for To do' }));
			await user.click(screen.getByRole('button', { name: 'Red' }));

			const options = getCollection(ydoc, collection.id)?.schema[0].options ?? [];
			expect(options[0].color).toBe('oklch(62% 0.18 25)');
		});

		it('reorders options with the down/up buttons', async () => {
			const { collection } = renderSelectField();
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await openOptionsEditor(user);
			await user.click(screen.getByRole('button', { name: 'Move To do down' }));

			const options = getCollection(ydoc, collection.id)?.schema[0].options ?? [];
			expect(options.map((o) => o.id)).toEqual(['done', 'todo']);
		});

		it('reorders options via drag and drop', async () => {
			const { collection } = renderSelectField();
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await openOptionsEditor(user);
			const rows = screen.getByRole('list').querySelectorAll('li');
			const [todoRow, doneRow] = Array.from(rows);
			const todoHandle = todoRow.querySelector('[draggable="true"]');
			if (!todoHandle) throw new Error('expected a drag handle inside the option row');

			// jsdom has no DataTransfer constructor — a minimal duck-typed stand-in
			// is enough since the component only calls dataTransfer.setData().
			const dataTransfer = { setData: () => {} } as unknown as DataTransfer;
			await fireEvent.dragStart(todoHandle, { dataTransfer });
			await fireEvent.dragOver(doneRow);
			await fireEvent.drop(doneRow);

			const options = getCollection(ydoc, collection.id)?.schema[0].options ?? [];
			expect(options.map((o) => o.id)).toEqual(['done', 'todo']);
		});

		it('deletes an option after confirming, showing the affected-record count and clearing it from records', async () => {
			const { collection } = renderSelectField();
			const record = createRecord(
				ydoc,
				{ parentId: collection.id, properties: { status: { type: 'select', value: 'todo' } } },
				{ kind: 'human', userId: 'local' }
			);
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await openOptionsEditor(user);
			await user.click(screen.getByRole('button', { name: 'Delete option To do' }));

			const dialog = screen.getByRole('dialog');
			expect(within(dialog).getByText(/1 record\(s\)/)).toBeInTheDocument();
			await user.click(within(dialog).getByRole('button', { name: 'Delete option' }));

			const options = getCollection(ydoc, collection.id)?.schema[0].options ?? [];
			expect(options.map((o) => o.id)).toEqual(['done']);
			expect(getRecord(ydoc, record.id)?.properties?.status).toBeUndefined();
		});

		// Regression: confirming (or cancelling) an option delete used to be
		// misread by handleWindowClick as an outside click — the confirm
		// button lives in a ConfirmDialog that isn't nested under the field
		// editor's own panel — which force-closed the whole "Edit field" panel
		// on every option delete, discarding any error along with it.
		it('keeps the field editor open after confirming an option delete, so other options stay reachable', async () => {
			const { collection } = renderSelectField();
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await openOptionsEditor(user);
			await user.click(screen.getByRole('button', { name: 'Delete option To do' }));
			await user.click(
				within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete option' })
			);

			expect(screen.getByRole('group', { name: 'Edit Status field' })).toBeInTheDocument();
		});

		it('cancelling the delete-option confirmation leaves it intact', async () => {
			const { collection } = renderSelectField();
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await openOptionsEditor(user);
			await user.click(screen.getByRole('button', { name: 'Delete option To do' }));
			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

			expect(getCollection(ydoc, collection.id)?.schema[0].options).toHaveLength(2);
		});

		it('surfaces an error instead of throwing when adding an option after a concurrent delete of the collection', async () => {
			const { collection } = renderSelectField();
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await openOptionsEditor(user);
			deleteCollection(ydoc, collection.id);
			await user.type(screen.getByLabelText('Add option'), 'Blocked');
			await user.click(screen.getByRole('button', { name: 'Add' }));

			expect(screen.getByText('Could not add the option. Please try again.')).toBeInTheDocument();
		});
	});

	// Regression coverage for two real bugs found in manual testing: the panel
	// used to be `position: absolute` inside the field's own header cell,
	// which (a) got clipped by Table's `overflow-x-auto` wrapper whenever the
	// table was too short for the panel to fit, and (b) whatever fixed z-index
	// it had only mattered relative to that ancestor's local stacking context,
	// not e.g. a "Manage fields" modal opened around it later.
	describe('the floating panel escapes ancestor clipping and stacking (regression)', () => {
		it('is portalled to document.body rather than staying nested under its trigger', async () => {
			const collection = createCollection(ydoc, {
				title: 'T',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await user.click(screen.getByRole('button', { name: 'Field options for Name' }));

			expect(screen.getByRole('menu').parentElement).toBe(document.body);
		});

		it('removes the portalled panel from the document once closed', async () => {
			const collection = createCollection(ydoc, {
				title: 'T',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await user.click(screen.getByRole('button', { name: 'Field options for Name' }));
			expect(document.body.querySelector('[role="menu"]')).not.toBeNull();

			await user.keyboard('{Escape}');

			expect(document.body.querySelector('[role="menu"]')).toBeNull();
		});

		it("carries a z-index that stacks above a modal overlay (e.g. FieldManagerDialog's z-40 backdrop)", async () => {
			const collection = createCollection(ydoc, {
				title: 'T',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await user.click(screen.getByRole('button', { name: 'Field options for Name' }));

			expect(screen.getByRole('menu')).toHaveClass('z-50');
		});

		it('caps its own height to the viewport and scrolls internally, so a short viewport cannot clip its lower controls', async () => {
			const collection = createCollection(ydoc, {
				title: 'T',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await user.click(screen.getByRole('button', { name: 'Field options for Name' }));

			const panel = screen.getByRole('menu');
			expect(panel).toHaveClass('max-h-[calc(100vh-16px)]');
			expect(panel).toHaveClass('overflow-y-auto');
		});
	});

	// These simulate another client (human or agent) deleting the Collection
	// concurrently, between the menu opening and the action being confirmed —
	// a real race in this multi-writer CRDT app, not a contrived scenario.
	describe('when the collection is deleted out from under an open action (concurrent-actor race)', () => {
		it('surfaces an error instead of throwing when saving a rename/retype', async () => {
			const collection = createCollection(ydoc, {
				title: 'T',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await user.click(screen.getByRole('button', { name: 'Field options for Name' }));
			await user.click(screen.getByRole('menuitem', { name: 'Edit field' }));
			deleteCollection(ydoc, collection.id);
			await user.click(screen.getByRole('button', { name: 'Save' }));

			expect(screen.getByText('Could not update the field. Please try again.')).toBeInTheDocument();
		});

		it('surfaces an error instead of throwing on insert', async () => {
			const collection = createCollection(ydoc, {
				title: 'T',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await user.click(screen.getByRole('button', { name: 'Field options for Name' }));
			deleteCollection(ydoc, collection.id);
			await user.click(screen.getByRole('menuitem', { name: 'Insert right' }));

			expect(screen.getByText('Could not insert a field. Please try again.')).toBeInTheDocument();
		});

		it('surfaces an error instead of throwing on duplicate', async () => {
			const collection = createCollection(ydoc, {
				title: 'T',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await user.click(screen.getByRole('button', { name: 'Field options for Name' }));
			deleteCollection(ydoc, collection.id);
			await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

			expect(
				screen.getByText('Could not duplicate the field. Please try again.')
			).toBeInTheDocument();
		});

		it('surfaces an error instead of throwing on delete confirm', async () => {
			const collection = createCollection(ydoc, {
				title: 'T',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			const user = userEvent.setup();
			render(FieldMenu, {
				collectionId: collection.id,
				schema: collection.schema,
				property: collection.schema[0]
			});

			await user.click(screen.getByRole('button', { name: 'Field options for Name' }));
			await user.click(screen.getByRole('menuitem', { name: 'Delete field' }));
			deleteCollection(ydoc, collection.id);
			await user.click(
				within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete field' })
			);

			expect(screen.getByText('Could not delete the field. Please try again.')).toBeInTheDocument();
		});
	});
});
