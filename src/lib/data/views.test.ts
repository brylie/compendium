import { describe, expect, it } from 'vitest';
import {
	applyFilters,
	applySort,
	dateKeyForRecord,
	groupBySelectProperty,
	primaryFieldDisplayValue,
	projectRecords,
	visibleProperties,
	type ViewConfig
} from './views';
import type { ActorId, PropertyDefinition, WorkspaceRecord } from './types';

const actor: ActorId = { kind: 'human', userId: 'local' };

function record(id: string, properties: WorkspaceRecord['properties']): WorkspaceRecord {
	return {
		id,
		parentId: 'collection-1',
		order: id,
		properties,
		createdBy: actor,
		createdAt: 0,
		lastEditedBy: actor,
		lastEditedAt: 0
	};
}

const statusProperty: PropertyDefinition = {
	key: 'status',
	label: 'Status',
	type: 'select',
	options: [
		{ id: 'todo', label: 'To do', color: 'gray' },
		{ id: 'done', label: 'Done', color: 'green' }
	]
};

const dueProperty: PropertyDefinition = { key: 'due', label: 'Due', type: 'date' };
const titleProperty: PropertyDefinition = { key: 'title', label: 'Title', type: 'text' };

describe('applyFilters', () => {
	it('returns all records when there are no filters', () => {
		const records = [record('a', {}), record('b', {})];
		expect(applyFilters(records, undefined)).toEqual(records);
		expect(applyFilters(records, [])).toEqual(records);
	});

	it('filters by "is" against an option id', () => {
		const records = [
			record('a', { status: { type: 'select', value: 'todo' } }),
			record('b', { status: { type: 'select', value: 'done' } })
		];
		const result = applyFilters(records, [{ propertyKey: 'status', op: 'is', value: 'done' }]);
		expect(result.map((r) => r.id)).toEqual(['b']);
	});

	it('filters by "is_not"', () => {
		const records = [
			record('a', { status: { type: 'select', value: 'todo' } }),
			record('b', { status: { type: 'select', value: 'done' } })
		];
		const result = applyFilters(records, [{ propertyKey: 'status', op: 'is_not', value: 'done' }]);
		expect(result.map((r) => r.id)).toEqual(['a']);
	});

	it('filters by "is_empty" and "is_not_empty"', () => {
		const records = [record('a', { due: { type: 'date', value: '2026-01-01' } }), record('b', {})];
		expect(
			applyFilters(records, [{ propertyKey: 'due', op: 'is_empty' }]).map((r) => r.id)
		).toEqual(['b']);
		expect(
			applyFilters(records, [{ propertyKey: 'due', op: 'is_not_empty' }]).map((r) => r.id)
		).toEqual(['a']);
	});

	it('combines multiple filters with AND semantics', () => {
		const records = [
			record('a', {
				status: { type: 'select', value: 'todo' },
				due: { type: 'date', value: '2026-01-01' }
			}),
			record('b', { status: { type: 'select', value: 'todo' } })
		];
		const result = applyFilters(records, [
			{ propertyKey: 'status', op: 'is', value: 'todo' },
			{ propertyKey: 'due', op: 'is_not_empty' }
		]);
		expect(result.map((r) => r.id)).toEqual(['a']);
	});
});

describe('applySort', () => {
	it('leaves manual-mode records untouched', () => {
		const records = [record('b', {}), record('a', {})];
		expect(applySort(records, [], { mode: 'manual' })).toEqual(records);
		expect(applySort(records, [], undefined)).toEqual(records);
	});

	it('sorts ascending by a text property, empties last', () => {
		const records = [
			record('a', { title: { type: 'text', value: 'Banana' } }),
			record('b', {}),
			record('c', { title: { type: 'text', value: 'Apple' } })
		];
		const result = applySort(records, [], { mode: 'property', propertyKey: 'title' });
		expect(result.map((r) => r.id)).toEqual(['c', 'a', 'b']);
	});

	it('sorts descending when requested', () => {
		const records = [
			record('a', { title: { type: 'text', value: 'Banana' } }),
			record('c', { title: { type: 'text', value: 'Apple' } })
		];
		const result = applySort(records, [], {
			mode: 'property',
			propertyKey: 'title',
			direction: 'desc'
		});
		expect(result.map((r) => r.id)).toEqual(['a', 'c']);
	});

	it('does not mutate the input array', () => {
		const records = [
			record('a', { title: { type: 'text', value: 'Banana' } }),
			record('c', { title: { type: 'text', value: 'Apple' } })
		];
		const original = [...records];
		applySort(records, [], { mode: 'property', propertyKey: 'title' });
		expect(records).toEqual(original);
	});

	it('sorts by a number property, including the greater-than branch', () => {
		const records = [
			record('a', { qty: { type: 'number', value: 1 } }),
			record('b', { qty: { type: 'number', value: 3 } }),
			record('c', { qty: { type: 'number', value: 2 } })
		];
		const result = applySort(records, [], { mode: 'property', propertyKey: 'qty' });
		expect(result.map((r) => r.id)).toEqual(['a', 'c', 'b']);
	});

	it('leaves equal values in their original relative order', () => {
		const records = [
			record('a', { qty: { type: 'number', value: 5 } }),
			record('b', { qty: { type: 'number', value: 5 } })
		];
		const result = applySort(records, [], { mode: 'property', propertyKey: 'qty' });
		expect(result.map((r) => r.id)).toEqual(['a', 'b']);
	});

	it('sorts by checkbox and relation properties', () => {
		const records = [
			record('a', { done: { type: 'checkbox', value: true } }),
			record('b', { done: { type: 'checkbox', value: false } })
		];
		expect(
			applySort(records, [], { mode: 'property', propertyKey: 'done' }).map((r) => r.id)
		).toEqual(['b', 'a']);

		const withRelations = [
			record('a', { links: { type: 'relation', value: ['z'] } }),
			record('b', { links: { type: 'relation', value: ['a'] } })
		];
		expect(
			applySort(withRelations, [], { mode: 'property', propertyKey: 'links' }).map((r) => r.id)
		).toEqual(['b', 'a']);
	});

	describe('select fields rank by configured option order, not option id (issue #95)', () => {
		const workflowProperty: PropertyDefinition = {
			key: 'status',
			label: 'Status',
			type: 'select',
			options: [
				// Deliberately id-ordered backwards from the configured workflow —
				// a plain string compare of these ids would sort in exactly the
				// wrong direction, which is the bug this field's fixture is meant
				// to catch.
				{ id: 'zzz-backlog', label: 'Backlog' },
				{ id: 'mmm-in-progress', label: 'In progress' },
				{ id: 'aaa-done', label: 'Done' }
			]
		};

		it('sorts ascending in configured option order, not by option id', () => {
			const records = [
				record('done-record', { status: { type: 'select', value: 'aaa-done' } }),
				record('backlog-record', { status: { type: 'select', value: 'zzz-backlog' } }),
				record('progress-record', { status: { type: 'select', value: 'mmm-in-progress' } })
			];
			const result = applySort(records, [workflowProperty], {
				mode: 'property',
				propertyKey: 'status'
			});
			expect(result.map((r) => r.id)).toEqual(['backlog-record', 'progress-record', 'done-record']);
		});

		it('sorts descending as the exact reverse of the configured option order', () => {
			const records = [
				record('backlog-record', { status: { type: 'select', value: 'zzz-backlog' } }),
				record('done-record', { status: { type: 'select', value: 'aaa-done' } }),
				record('progress-record', { status: { type: 'select', value: 'mmm-in-progress' } })
			];
			const result = applySort(records, [workflowProperty], {
				mode: 'property',
				propertyKey: 'status',
				direction: 'desc'
			});
			expect(result.map((r) => r.id)).toEqual(['done-record', 'progress-record', 'backlog-record']);
		});

		it('sorts an unassigned (empty) value last, regardless of direction', () => {
			const records = [
				record('done-record', { status: { type: 'select', value: 'aaa-done' } }),
				record('unassigned-record', {}),
				record('backlog-record', { status: { type: 'select', value: 'zzz-backlog' } })
			];
			const asc = applySort(records, [workflowProperty], {
				mode: 'property',
				propertyKey: 'status'
			});
			expect(asc.map((r) => r.id)).toEqual(['backlog-record', 'done-record', 'unassigned-record']);

			const desc = applySort(records, [workflowProperty], {
				mode: 'property',
				propertyKey: 'status',
				direction: 'desc'
			});
			expect(desc.map((r) => r.id)).toEqual(['done-record', 'backlog-record', 'unassigned-record']);
		});

		it('sorts a legacy/unknown option id as if it were empty — same bucket groupBySelectProperty already puts it in', () => {
			const records = [
				record('done-record', { status: { type: 'select', value: 'aaa-done' } }),
				record('stale-record', { status: { type: 'select', value: 'no-longer-an-option' } }),
				record('backlog-record', { status: { type: 'select', value: 'zzz-backlog' } })
			];
			const result = applySort(records, [workflowProperty], {
				mode: 'property',
				propertyKey: 'status'
			});
			expect(result.map((r) => r.id)).toEqual(['backlog-record', 'done-record', 'stale-record']);
		});

		it('treats every select value as empty (not a lexical id compare) when no schema entry is found for the sort key', () => {
			// Input order is deliberately the *opposite* of what a lexical id
			// compare would produce ('aaa-done' < 'zzz-backlog' as strings) — so
			// if selectOptionRank ever silently fell back to comparing raw ids
			// instead of returning undefined for a property it can't resolve,
			// this would come back reordered to ['a', 'b'] and fail.
			const records = [
				record('b', { status: { type: 'select', value: 'zzz-backlog' } }),
				record('a', { status: { type: 'select', value: 'aaa-done' } })
			];
			// No schema passed for 'status', so selectOptionRank(undefined, id)
			// returns undefined for both — every select value lands in the same
			// "empty" bucket applySort's own isEmptyComparable check already
			// treats as tied, and a tied comparator preserves input order
			// (Array.prototype.sort is stable) rather than reordering by id.
			const result = applySort(records, [], { mode: 'property', propertyKey: 'status' });
			expect(result.map((r) => r.id)).toEqual(['b', 'a']);
		});

		it("agrees with groupBySelectProperty's Board column order — one canonical Select-order contract", () => {
			const records = [
				record('done-record', { status: { type: 'select', value: 'aaa-done' } }),
				record('backlog-record', { status: { type: 'select', value: 'zzz-backlog' } }),
				record('progress-record', { status: { type: 'select', value: 'mmm-in-progress' } })
			];
			const sortedIds = applySort(records, [workflowProperty], {
				mode: 'property',
				propertyKey: 'status'
			}).map((r) => r.id);
			const boardColumnOrder = groupBySelectProperty(records, workflowProperty)
				.flatMap((column) => column.records)
				.map((r) => r.id);
			expect(sortedIds).toEqual(boardColumnOrder);
		});
	});
});

describe('projectRecords', () => {
	it('applies filters then sort together', () => {
		const records = [
			record('a', {
				status: { type: 'select', value: 'todo' },
				title: { type: 'text', value: 'Zebra' }
			}),
			record('b', {
				status: { type: 'select', value: 'done' },
				title: { type: 'text', value: 'Apple' }
			}),
			record('c', {
				status: { type: 'select', value: 'todo' },
				title: { type: 'text', value: 'Mango' }
			})
		];
		const config: ViewConfig = {
			filters: [{ propertyKey: 'status', op: 'is', value: 'todo' }],
			sort: { mode: 'property', propertyKey: 'title' }
		};
		expect(
			projectRecords(records, [statusProperty, titleProperty], config).map((r) => r.id)
		).toEqual(['c', 'a']);
	});
});

describe('visibleProperties', () => {
	const schema = [titleProperty, statusProperty, dueProperty];

	it('returns the full schema when unconfigured', () => {
		expect(visibleProperties(schema, {})).toEqual(schema);
	});

	it('filters down to the configured keys, preserving schema order', () => {
		const result = visibleProperties(schema, { visibleProperties: ['due', 'title'] });
		expect(result.map((p) => p.key)).toEqual(['title', 'due']);
	});
});

describe('groupBySelectProperty', () => {
	it('creates one column per schema option, in schema order, even when empty', () => {
		const columns = groupBySelectProperty([], statusProperty);
		expect(columns.map((c) => c.optionId)).toEqual(['todo', 'done', null]);
		expect(columns.every((c) => c.records.length === 0)).toBe(true);
	});

	it('buckets records into their matching option column', () => {
		const records = [
			record('a', { status: { type: 'select', value: 'todo' } }),
			record('b', { status: { type: 'select', value: 'done' } }),
			record('c', { status: { type: 'select', value: 'todo' } })
		];
		const columns = groupBySelectProperty(records, statusProperty);
		expect(columns.find((c) => c.optionId === 'todo')?.records.map((r) => r.id)).toEqual([
			'a',
			'c'
		]);
		expect(columns.find((c) => c.optionId === 'done')?.records.map((r) => r.id)).toEqual(['b']);
	});

	it('buckets records with no value, or an option id no longer in the schema, into the catch-all column', () => {
		const records = [
			record('a', {}),
			record('b', { status: { type: 'select', value: 'archived-option' } })
		];
		const columns = groupBySelectProperty(records, statusProperty);
		const unassigned = columns.find((c) => c.optionId === null);
		expect(unassigned?.label).toBe('No Status');
		expect(unassigned?.records.map((r) => r.id).sort()).toEqual(['a', 'b']);
	});

	it('never creates placeholder records for an empty column', () => {
		const columns = groupBySelectProperty([record('a', {})], statusProperty);
		const todoColumn = columns.find((c) => c.optionId === 'todo');
		expect(todoColumn?.records).toEqual([]);
	});
});

describe('primaryFieldDisplayValue', () => {
	it('returns an empty string when there is no value or no property', () => {
		expect(primaryFieldDisplayValue(undefined, titleProperty)).toBe('');
		expect(primaryFieldDisplayValue({ type: 'text', value: 'x' }, undefined)).toBe('');
	});

	it('renders text and number values directly', () => {
		expect(primaryFieldDisplayValue({ type: 'text', value: 'Alice' }, titleProperty)).toBe('Alice');
		const qty: PropertyDefinition = { key: 'qty', label: 'Qty', type: 'number' };
		expect(primaryFieldDisplayValue({ type: 'number', value: 5 }, qty)).toBe('5');
	});

	it('resolves a select value to its option label', () => {
		expect(primaryFieldDisplayValue({ type: 'select', value: 'done' }, statusProperty)).toBe(
			'Done'
		);
	});

	it('returns an empty string for a relation value — it has no single display string', () => {
		const relationProperty: PropertyDefinition = { key: 'links', label: 'Links', type: 'relation' };
		expect(
			primaryFieldDisplayValue({ type: 'relation', value: ['a', 'b'] }, relationProperty)
		).toBe('');
	});
});

describe('dateKeyForRecord', () => {
	it('returns the YYYY-MM-DD portion of a date property value', () => {
		const r = record('a', { due: { type: 'date', value: '2026-03-15' } });
		expect(dateKeyForRecord(r, dueProperty)).toBe('2026-03-15');
	});

	it('truncates a datetime value down to its date portion', () => {
		const r = record('a', { due: { type: 'date', value: '2026-03-15T09:30:00Z' } });
		expect(dateKeyForRecord(r, dueProperty)).toBe('2026-03-15');
	});

	it('returns undefined when the property is unset or empty', () => {
		expect(dateKeyForRecord(record('a', {}), dueProperty)).toBeUndefined();
		expect(dateKeyForRecord(record('a', { due: { type: 'date', value: '' } }), dueProperty)).toBe(
			undefined
		);
	});

	it('returns undefined when the record has a value of the wrong property type', () => {
		const r = record('a', { due: { type: 'text', value: 'not a date' } });
		expect(dateKeyForRecord(r, dueProperty)).toBeUndefined();
	});
});
