import { describe, expect, it } from 'vitest';
import {
	applyFilters,
	applySort,
	computeFieldSummary,
	dateKeyForRecord,
	diffViewConfig,
	fieldSummaryLabel,
	groupBySelectProperty,
	groupBySwimlaneAndColumn,
	primaryFieldDisplayValue,
	projectRecords,
	summaryOptionsForType,
	viewConfigsEqual,
	visibleProperties,
	type ViewConfig
} from './views';
import type { ActorId, FieldSummaryType, PropertyDefinition, WorkspaceRecord } from './types';

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

	it('treats a missing property value as an empty string for "is"/"is_not" comparisons', () => {
		const records = [record('a', {}), record('b', { status: { type: 'select', value: 'todo' } })];
		expect(
			applyFilters(records, [{ propertyKey: 'status', op: 'is', value: '' }]).map((r) => r.id)
		).toEqual(['a']);
		expect(
			applyFilters(records, [{ propertyKey: 'status', op: 'is_not', value: '' }]).map((r) => r.id)
		).toEqual(['b']);
	});

	it('treats a missing filter value as an empty string for "is"/"is_not" comparisons', () => {
		const records = [record('a', {}), record('b', { status: { type: 'select', value: 'todo' } })];
		expect(applyFilters(records, [{ propertyKey: 'status', op: 'is' }]).map((r) => r.id)).toEqual([
			'a'
		]);
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

	it('handles a select property with no configured options — just the catch-all column', () => {
		const noOptionsProperty: PropertyDefinition = {
			key: 'status',
			label: 'Status',
			type: 'select'
		};
		const columns = groupBySelectProperty([record('a', {})], noOptionsProperty);
		expect(columns.map((c) => c.optionId)).toEqual([null]);
		expect(columns[0].records.map((r) => r.id)).toEqual(['a']);
	});
});

describe('groupBySwimlaneAndColumn (issue #67/#165)', () => {
	const priorityProperty: PropertyDefinition = {
		key: 'priority',
		label: 'Priority',
		type: 'select',
		options: [
			{ id: 'high', label: 'High', color: 'red' },
			{ id: 'low', label: 'Low', color: 'blue' }
		]
	};

	it('creates one swimlane per schema option (plus a catch-all), each with the full set of columns, even when empty', () => {
		const swimlanes = groupBySwimlaneAndColumn([], statusProperty, priorityProperty);
		expect(swimlanes.map((s) => s.optionId)).toEqual(['high', 'low', null]);
		for (const swimlane of swimlanes) {
			expect(swimlane.columns.map((c) => c.optionId)).toEqual(['todo', 'done', null]);
			expect(swimlane.columns.every((c) => c.records.length === 0)).toBe(true);
		}
	});

	it('crosses swimlane and column membership — a record lands in exactly one cell', () => {
		const records = [
			record('a', {
				status: { type: 'select', value: 'todo' },
				priority: { type: 'select', value: 'high' }
			}),
			record('b', {
				status: { type: 'select', value: 'done' },
				priority: { type: 'select', value: 'high' }
			}),
			record('c', {
				status: { type: 'select', value: 'todo' },
				priority: { type: 'select', value: 'low' }
			})
		];
		const swimlanes = groupBySwimlaneAndColumn(records, statusProperty, priorityProperty);

		const high = swimlanes.find((s) => s.optionId === 'high')!;
		expect(high.columns.find((c) => c.optionId === 'todo')?.records.map((r) => r.id)).toEqual([
			'a'
		]);
		expect(high.columns.find((c) => c.optionId === 'done')?.records.map((r) => r.id)).toEqual([
			'b'
		]);

		const low = swimlanes.find((s) => s.optionId === 'low')!;
		expect(low.columns.find((c) => c.optionId === 'todo')?.records.map((r) => r.id)).toEqual(['c']);
		expect(low.columns.find((c) => c.optionId === 'done')?.records).toEqual([]);
	});

	it('preserves an empty swimlane — every column still renders inside it, with zero records', () => {
		const records = [
			record('a', {
				status: { type: 'select', value: 'todo' },
				priority: { type: 'select', value: 'high' }
			})
		];
		const swimlanes = groupBySwimlaneAndColumn(records, statusProperty, priorityProperty);

		const low = swimlanes.find((s) => s.optionId === 'low')!;
		expect(low.columns.map((c) => c.optionId)).toEqual(['todo', 'done', null]);
		expect(low.columns.every((c) => c.records.length === 0)).toBe(true);
	});

	it('buckets records with no swimlane value, or a stale swimlane option id, into the catch-all swimlane', () => {
		const records = [
			record('a', { status: { type: 'select', value: 'todo' } }),
			record('b', {
				status: { type: 'select', value: 'todo' },
				priority: { type: 'select', value: 'archived-option' }
			})
		];
		const swimlanes = groupBySwimlaneAndColumn(records, statusProperty, priorityProperty);

		const unassigned = swimlanes.find((s) => s.optionId === null)!;
		expect(unassigned.label).toBe('No Priority');
		expect(
			unassigned.columns
				.find((c) => c.optionId === 'todo')
				?.records.map((r) => r.id)
				.sort()
		).toEqual(['a', 'b']);
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

	it('renders a date value directly', () => {
		const dateProperty: PropertyDefinition = { key: 'due', label: 'Due', type: 'date' };
		expect(primaryFieldDisplayValue({ type: 'date', value: '2026-09-01' }, dateProperty)).toBe(
			'2026-09-01'
		);
	});

	it('renders a checkbox value as Checked or empty', () => {
		const checkboxProperty: PropertyDefinition = { key: 'done', label: 'Done', type: 'checkbox' };
		expect(primaryFieldDisplayValue({ type: 'checkbox', value: true }, checkboxProperty)).toBe(
			'Checked'
		);
		expect(primaryFieldDisplayValue({ type: 'checkbox', value: false }, checkboxProperty)).toBe('');
	});

	it('returns an empty string for a select value with no matching option', () => {
		expect(
			primaryFieldDisplayValue({ type: 'select', value: 'not-a-real-option' }, statusProperty)
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
		expect(
			dateKeyForRecord(record('a', { due: { type: 'date', value: '' } }), dueProperty)
		).toBeUndefined();
	});

	it('returns undefined when the record has a value of the wrong property type', () => {
		const r = record('a', { due: { type: 'text', value: 'not a date' } });
		expect(dateKeyForRecord(r, dueProperty)).toBeUndefined();
	});
});

describe('viewConfigsEqual', () => {
	it('treats two empty configs as equal', () => {
		expect(viewConfigsEqual({}, {})).toBe(true);
	});

	it('detects a filter difference', () => {
		const a: ViewConfig = { filters: [{ propertyKey: 'status', op: 'is', value: 'done' }] };
		const b: ViewConfig = { filters: [{ propertyKey: 'status', op: 'is', value: 'todo' }] };
		expect(viewConfigsEqual(a, a)).toBe(true);
		expect(viewConfigsEqual(a, b)).toBe(false);
		expect(viewConfigsEqual(a, {})).toBe(false);
	});

	it('detects a sort difference, treating undefined and manual-mode-with-no-key as distinct only when the shape actually differs', () => {
		expect(viewConfigsEqual({ sort: { mode: 'manual' } }, { sort: { mode: 'manual' } })).toBe(true);
		expect(
			viewConfigsEqual(
				{ sort: { mode: 'property', propertyKey: 'title', direction: 'asc' } },
				{ sort: { mode: 'property', propertyKey: 'title', direction: 'desc' } }
			)
		).toBe(false);
		expect(viewConfigsEqual({ sort: { mode: 'manual' } }, {})).toBe(false);
	});

	it('treats visibleProperties as a set — order doesn’t matter', () => {
		expect(
			viewConfigsEqual({ visibleProperties: ['a', 'b'] }, { visibleProperties: ['b', 'a'] })
		).toBe(true);
		expect(viewConfigsEqual({ visibleProperties: ['a', 'b'] }, { visibleProperties: ['a'] })).toBe(
			false
		);
	});

	it('detects a groupBy difference', () => {
		expect(viewConfigsEqual({ groupBy: 'status' }, { groupBy: 'priority' })).toBe(false);
		expect(viewConfigsEqual({ groupBy: 'status' }, { groupBy: 'status' })).toBe(true);
	});

	it('detects a swimlaneBy difference (issue #67/#165)', () => {
		expect(viewConfigsEqual({ swimlaneBy: 'priority' }, { swimlaneBy: 'assignee' })).toBe(false);
		expect(viewConfigsEqual({ swimlaneBy: 'priority' }, { swimlaneBy: 'priority' })).toBe(true);
		expect(viewConfigsEqual({ swimlaneBy: 'priority' }, {})).toBe(false);
	});

	it('detects a summaries difference, ignoring key order', () => {
		expect(
			viewConfigsEqual(
				{ summaries: { a: 'sum', b: 'count_all' } },
				{ summaries: { b: 'count_all', a: 'sum' } }
			)
		).toBe(true);
		expect(viewConfigsEqual({ summaries: { a: 'sum' } }, { summaries: { a: 'average' } })).toBe(
			false
		);
		expect(viewConfigsEqual({ summaries: { a: 'sum' } }, {})).toBe(false);
	});
});

describe('diffViewConfig', () => {
	it('returns an empty patch when nothing changed', () => {
		const config: ViewConfig = { groupBy: 'status', filters: [] };
		expect(diffViewConfig(config, { ...config })).toEqual({});
	});

	it('includes only the members that actually changed', () => {
		const base: ViewConfig = { groupBy: 'status', sort: { mode: 'manual' } };
		const next: ViewConfig = {
			groupBy: 'status',
			sort: { mode: 'property', propertyKey: 'title' }
		};
		expect(diffViewConfig(base, next)).toEqual({
			sort: { mode: 'property', propertyKey: 'title' }
		});
	});

	it('includes a member reset back to undefined, so the patch clears it', () => {
		expect(diffViewConfig({ groupBy: 'status' }, {})).toEqual({ groupBy: undefined });
	});

	it('includes a swimlaneBy change (issue #67/#165), same as groupBy', () => {
		expect(diffViewConfig({}, { swimlaneBy: 'priority' })).toEqual({ swimlaneBy: 'priority' });
		expect(diffViewConfig({ swimlaneBy: 'priority' }, {})).toEqual({ swimlaneBy: undefined });
		expect(diffViewConfig({ swimlaneBy: 'priority' }, { swimlaneBy: 'priority' })).toEqual({});
	});

	// Issue #183 review: undefined (show every property) and [] (show none)
	// are both empty sets to stringSetEqual, but mean opposite things — a
	// transition between them must still produce a patch, or a viewer's
	// "hide every column" edit would silently fail to save.
	it('distinguishes an unset visibleProperties override from an explicit empty allowlist', () => {
		expect(diffViewConfig({}, { visibleProperties: [] })).toEqual({ visibleProperties: [] });
		expect(diffViewConfig({ visibleProperties: [] }, {})).toEqual({ visibleProperties: undefined });
		expect(diffViewConfig({ visibleProperties: ['a'] }, { visibleProperties: [] })).toEqual({
			visibleProperties: []
		});
	});
});

describe('summaryOptionsForType', () => {
	it('offers numeric aggregations for number properties', () => {
		expect(summaryOptionsForType('number')).toEqual([
			'none',
			'count_all',
			'count_values',
			'count_empty',
			'sum',
			'average',
			'min',
			'max'
		]);
	});

	it('offers earliest/latest for date properties, not sum/average', () => {
		const options = summaryOptionsForType('date');
		expect(options).toContain('earliest');
		expect(options).toContain('latest');
		expect(options).not.toContain('sum');
	});

	it('offers checked/unchecked for checkbox properties', () => {
		expect(summaryOptionsForType('checkbox')).toEqual([
			'none',
			'count_all',
			'checked',
			'unchecked'
		]);
	});

	it('offers only generic count aggregations for text/select/relation properties', () => {
		const generic: FieldSummaryType[] = ['none', 'count_all', 'count_values', 'count_empty'];
		expect(summaryOptionsForType('text')).toEqual(generic);
		expect(summaryOptionsForType('select')).toEqual(generic);
		expect(summaryOptionsForType('relation')).toEqual(generic);
	});
});

describe('fieldSummaryLabel', () => {
	it('has a human label for every FieldSummaryType', () => {
		const allTypes: FieldSummaryType[] = [
			'none',
			'count_all',
			'count_values',
			'count_empty',
			'sum',
			'average',
			'min',
			'max',
			'earliest',
			'latest',
			'checked',
			'unchecked'
		];
		for (const type of allTypes) {
			expect(fieldSummaryLabel(type)).toMatch(/\S/);
		}
	});
});

describe('computeFieldSummary', () => {
	const qtyProperty: PropertyDefinition = { key: 'qty', label: 'Qty', type: 'number' };
	const doneProperty: PropertyDefinition = { key: 'done', label: 'Done', type: 'checkbox' };

	it('returns an empty string for "none"', () => {
		expect(computeFieldSummary([record('a', {})], titleProperty, 'none')).toBe('');
	});

	it('counts all records, records with a value, and empty records', () => {
		const records = [
			record('a', { title: { type: 'text', value: 'x' } }),
			record('b', {}),
			record('c', { title: { type: 'text', value: 'y' } })
		];
		expect(computeFieldSummary(records, titleProperty, 'count_all')).toBe('3');
		expect(computeFieldSummary(records, titleProperty, 'count_values')).toBe('2');
		expect(computeFieldSummary(records, titleProperty, 'count_empty')).toBe('1');
	});

	it('sums, averages, mins, and maxes a number property, ignoring empty rows', () => {
		const records = [
			record('a', { qty: { type: 'number', value: 3 } }),
			record('b', {}),
			record('c', { qty: { type: 'number', value: 5 } }),
			record('d', { qty: { type: 'number', value: 10 } })
		];
		expect(computeFieldSummary(records, qtyProperty, 'sum')).toBe('18');
		expect(computeFieldSummary(records, qtyProperty, 'average')).toBe('6');
		expect(computeFieldSummary(records, qtyProperty, 'min')).toBe('3');
		expect(computeFieldSummary(records, qtyProperty, 'max')).toBe('10');
	});

	it('rounds average to 2 decimal places', () => {
		const records = [
			record('a', { qty: { type: 'number', value: 1 } }),
			record('b', { qty: { type: 'number', value: 2 } }),
			record('c', { qty: { type: 'number', value: 2 } })
		];
		expect(computeFieldSummary(records, qtyProperty, 'average')).toBe('1.67');
	});

	it('returns an empty string for sum/average/min/max when every row is empty', () => {
		const records = [record('a', {})];
		expect(computeFieldSummary(records, qtyProperty, 'sum')).toBe('0');
		expect(computeFieldSummary(records, qtyProperty, 'average')).toBe('');
		expect(computeFieldSummary(records, qtyProperty, 'min')).toBe('');
		expect(computeFieldSummary(records, qtyProperty, 'max')).toBe('');
	});

	it('finds earliest and latest date values, ignoring empty rows', () => {
		const records = [
			record('a', { due: { type: 'date', value: '2026-03-15' } }),
			record('b', {}),
			record('c', { due: { type: 'date', value: '2026-01-01' } }),
			record('d', { due: { type: 'date', value: '2026-06-01' } })
		];
		expect(computeFieldSummary(records, dueProperty, 'earliest')).toBe('2026-01-01');
		expect(computeFieldSummary(records, dueProperty, 'latest')).toBe('2026-06-01');
	});

	it('counts checked and unchecked checkboxes, treating an unset value as unchecked', () => {
		const records = [
			record('a', { done: { type: 'checkbox', value: true } }),
			record('b', { done: { type: 'checkbox', value: false } }),
			record('c', {})
		];
		expect(computeFieldSummary(records, doneProperty, 'checked')).toBe('1');
		expect(computeFieldSummary(records, doneProperty, 'unchecked')).toBe('2');
	});
});
