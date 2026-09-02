// A thin typed layer over the specific Y.Map operations src/lib/data/records.ts
// (and friends) actually use — get/set/has/delete on a Y.Map<unknown> whose
// entries have a known field shape, plus the same for a top-level
// Y.Map<Y.Map<unknown>> registry (documents/collections/records). This is the
// one place an untyped CRDT read gets narrowed to a real TypeScript type, so
// the rest of the app never needs its own `as X` cast on a Y.Map read (issue
// #174) — not a generic re-implementation of Yjs's Map API.
import * as Y from 'yjs';

/** Typed view over a Y.Map<unknown> whose entries follow a known field shape T. */
export class TypedYMap<T extends object> {
	constructor(readonly raw: Y.Map<unknown>) {}

	get<K extends keyof T & string>(key: K): T[K] | undefined {
		return this.raw.get(key) as T[K] | undefined;
	}

	set<K extends keyof T & string>(key: K, value: T[K]): void {
		this.raw.set(key, value);
	}

	has(key: keyof T & string): boolean {
		return this.raw.has(key);
	}

	delete(key: keyof T & string): void {
		this.raw.delete(key);
	}
}

/** Wraps an existing Y.Map<unknown> (or a freshly constructed one) as a TypedYMap<T>. */
export function typedYMap<T extends object>(raw: Y.Map<unknown>): TypedYMap<T> {
	return new TypedYMap<T>(raw);
}

/**
 * Typed view over a top-level `Y.Map<Y.Map<unknown>>` registry (the
 * documents/collections/records maps) whose entries are each a TypedYMap<T>.
 */
export class TypedYMapRegistry<T extends object> {
	constructor(private readonly raw: Y.Map<Y.Map<unknown>>) {}

	get(id: string): TypedYMap<T> | undefined {
		const entry = this.raw.get(id);
		return entry ? new TypedYMap<T>(entry) : undefined;
	}

	has(id: string): boolean {
		return this.raw.has(id);
	}

	set(id: string, entry: Y.Map<unknown>): TypedYMap<T> {
		this.raw.set(id, entry);
		return new TypedYMap<T>(entry);
	}

	delete(id: string): void {
		this.raw.delete(id);
	}

	forEach(callback: (entry: TypedYMap<T>, id: string) => void): void {
		this.raw.forEach((entry, id) => callback(new TypedYMap<T>(entry), id));
	}
}

/** Wraps an existing top-level `Y.Map<Y.Map<unknown>>` as a TypedYMapRegistry<T>. */
export function typedYMapRegistry<T extends object>(
	raw: Y.Map<Y.Map<unknown>>
): TypedYMapRegistry<T> {
	return new TypedYMapRegistry<T>(raw);
}
