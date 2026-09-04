import * as Y from 'yjs';

/** Every Yjs write source accepted by Compendium's projection observers. */
export type MutationSource =
	| 'local-ui'
	| 'remote-ui'
	| 'service'
	| 'migration'
	| 'replay'
	| 'undo-redo'
	| 'test';

export interface MutationOrigin {
	readonly source: MutationSource;
	readonly detail?: string;
}

function origin(source: MutationSource, detail?: string): MutationOrigin {
	return Object.freeze({ source, detail });
}

export const LOCAL_UI_ORIGIN = origin('local-ui');
export const SERVICE_ORIGIN = origin('service');
export const MIGRATION_ORIGIN = origin('migration');
export const REPLAY_ORIGIN = origin('replay');
export const TEST_ORIGIN = origin('test');

/** A connection-specific server-side origin for an update received over y-websocket. */
export function remoteUiOrigin(connectionId: string): MutationOrigin {
	return origin('remote-ui', connectionId);
}

/** Runs a mutation under one of the named origins; nested Yjs transactions retain it. */
export function transactWithOrigin<T>(
	doc: Y.Doc,
	transactionOrigin: MutationOrigin,
	mutate: () => T
): T {
	let result!: T;
	doc.transact(() => {
		result = mutate();
	}, transactionOrigin);
	return result;
}

const undoRedoOrigins = new WeakSet<object>();

/** Registers a Y.UndoManager's internal transaction origin with the shared classifier. */
export function registerUndoRedoOrigin(originObject: object): void {
	undoRedoOrigins.add(originObject);
}

export function mutationSource(originValue: unknown): MutationSource | undefined {
	if (
		typeof originValue === 'object' &&
		originValue !== null &&
		'source' in originValue &&
		typeof originValue.source === 'string' &&
		['local-ui', 'remote-ui', 'service', 'migration', 'replay', 'undo-redo', 'test'].includes(
			originValue.source
		)
	) {
		return originValue.source as MutationSource;
	}
	return typeof originValue === 'object' && originValue !== null && undoRedoOrigins.has(originValue)
		? 'undo-redo'
		: undefined;
}

export class UnknownMutationOriginError extends Error {
	constructor(originValue: unknown) {
		super(`Yjs mutation used an unrecognized origin: ${String(originValue)}`);
		this.name = 'UnknownMutationOriginError';
	}
}
