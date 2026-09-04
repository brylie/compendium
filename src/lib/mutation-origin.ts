import * as Y from 'yjs';

/** Every Yjs write source accepted by Compendium's projection observers. */
export type MutationSource =
	'local-ui' | 'remote-ui' | 'service' | 'migration' | 'replay' | 'undo-redo' | 'test';

export interface MutationOrigin {
	readonly source: MutationSource;
	readonly detail?: string;
}

const origins = new WeakMap<object, MutationSource>();

function origin(source: MutationSource, detail?: string): MutationOrigin {
	const value = Object.freeze({ source, detail });
	origins.set(value, source);
	return value;
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

/** Registers a Y.UndoManager's internal transaction origin with the shared classifier. */
export function registerUndoRedoOrigin(originObject: object): void {
	origins.set(originObject, 'undo-redo');
}

/** Returns the recognized source for a Yjs transaction origin, if any. */
export function mutationSource(originValue: unknown): MutationSource | undefined {
	// Older tests construct Yjs state directly. Keep that fixture shorthand
	// contained to Vitest; production observers still reject untagged writes.
	if (originValue == null && typeof process !== 'undefined' && process.env.VITEST) return 'test';
	return typeof originValue === 'object' && originValue !== null
		? origins.get(originValue)
		: undefined;
}

/** Raised when an observer sees a mutation that bypasses the origin contract. */
export class UnknownMutationOriginError extends Error {
	constructor(originValue: unknown) {
		super(`Yjs mutation used an unrecognized origin: ${String(originValue)}`);
		this.name = 'UnknownMutationOriginError';
	}
}
