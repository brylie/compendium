import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { actorKey, formatActor } from '$lib/data/format';
import type { WorkspaceRecord } from '$lib/data/types';
import { CURRENT_USER } from './actor';

// Toggled into the announced text below to guarantee a screen reader
// re-announces it even when two consecutive, distinct transitions happen to
// produce identical wording — a live region only re-fires on an actual text
// change, and this doesn't affect what's read aloud. Same technique as the
// Document editor's held-block announcements (PR #159).
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/** "a row"/"an event" — the generic messages below need the noun's indefinite article, not just the noun itself. */
function withArticle(noun: string, capitalize = false): string {
	const article = /^[aeiou]/i.test(noun) ? 'an' : 'a';
	const prefix = capitalize ? article[0].toUpperCase() + article.slice(1) : article;
	return `${prefix} ${noun}`;
}

export interface RemoteUpdateAnnouncerOptions {
	/** Singular noun for one record in this view — "row", "card", "event". */
	noun: string;
	/**
	 * Returns a specific verb phrase for an edit to a record present in both
	 * the previous and current snapshot (e.g. "moved to Done", "rescheduled to
	 * 2026-09-12") — return undefined to fall back to the generic "edited a
	 * <noun>". Never called for adds/removes, where there's no "previous"
	 * value to compare against.
	 */
	describeEdit?: (previous: WorkspaceRecord, current: WorkspaceRecord) => string | undefined;
}

export interface RemoteUpdateAnnouncer {
	/** The live region's current text — empty until the first remote transition this instance observes. */
	readonly text: string;
	/** Diffs `rows` against the previously-seen snapshot and updates `text` with any remote transitions found. Call once per useCollectionView onSnapshot. */
	notify(rows: WorkspaceRecord[]): void;
	/** Marks `id` as a locally-initiated removal, so the next `notify()` that observes it gone reports it silently rather than as an unattributed remote change. Call synchronously before removing a row/card/event. */
	noteLocalRemoval(id: string): void;
	/** Clears tracked state — call when retargeting to a different Collection, so rows from the previous one aren't diffed against the new one's first snapshot. */
	reset(): void;
}

function isRemote(actor: WorkspaceRecord['createdBy']): boolean {
	return actorKey(actor) !== actorKey(CURRENT_USER);
}

/** The "X added/edited a <noun>" message for one record present in both snapshots — undefined when nothing worth announcing changed. */
function describeExistingRecord(
	prior: WorkspaceRecord,
	record: WorkspaceRecord,
	noun: string,
	describeEdit: RemoteUpdateAnnouncerOptions['describeEdit']
): string | undefined {
	if (prior.lastEditedAt === record.lastEditedAt) return undefined;
	if (!isRemote(record.lastEditedBy)) return undefined;
	const detail = describeEdit?.(prior, record) ?? `edited ${withArticle(noun)}`;
	return `${formatActor(record.lastEditedBy)} ${detail}`;
}

/**
 * Shared screen-reader live-region diffing for Table/Board/Calendar (issue
 * #167), reusing the pattern the Document editor's held-block announcements
 * established (PR #159; see docs/specifications/collaboration.md): a
 * persistent aria-live="polite"/role="status" region, diffing the previous
 * vs. current snapshot to build a transition message, suppressing the
 * initial snapshot (a client's first read isn't a transition it observed),
 * and toggling a zero-width-space marker so two consecutive announcements
 * with identical wording still register as a text change to assistive tech.
 *
 * Unlike PR #159 — which diffs ephemeral Awareness state already filtered to
 * "held by others" — this diffs persisted Yjs record content, so "remote" is
 * determined per-record from `createdBy`/`lastEditedBy` against
 * `CURRENT_USER` (Phase 0's single fixed local identity). A removed record
 * carries no actor at all (it's simply gone from the snapshot), so a caller
 * must proactively flag its own deletions via `noteLocalRemoval` for those to
 * stay silent — a remaining removal is reported unattributed, "A <noun> was
 * removed", rather than misattributed.
 */
export function useRemoteUpdateAnnouncer(
	options: RemoteUpdateAnnouncerOptions
): RemoteUpdateAnnouncer {
	let text = $state('');
	let toggle = false;
	let previous: SvelteMap<string, WorkspaceRecord> | undefined;
	let pendingLocalRemovals = new SvelteSet<string>();

	function announce(messages: string[]): void {
		if (messages.length === 0) return;
		toggle = !toggle;
		text = (toggle ? ZERO_WIDTH_SPACE : '') + messages.join('; ');
	}

	return {
		get text() {
			return text;
		},
		notify(rows: WorkspaceRecord[]): void {
			const current = new SvelteMap(rows.map((r) => [r.id, r] as const));
			if (!previous) {
				previous = current;
				return;
			}

			const messages: string[] = [];
			for (const [id, record] of current) {
				const prior = previous.get(id);
				if (!prior) {
					if (isRemote(record.createdBy)) {
						messages.push(`${formatActor(record.createdBy)} added ${withArticle(options.noun)}`);
					}
					continue;
				}
				const message = describeExistingRecord(prior, record, options.noun, options.describeEdit);
				if (message) messages.push(message);
			}
			for (const [id] of previous) {
				if (current.has(id)) continue;
				if (pendingLocalRemovals.delete(id)) continue;
				messages.push(`${withArticle(options.noun, true)} was removed`);
			}

			previous = current;
			announce(messages);
		},
		noteLocalRemoval(id: string): void {
			pendingLocalRemovals.add(id);
		},
		reset(): void {
			text = '';
			toggle = false;
			previous = undefined;
			pendingLocalRemovals = new SvelteSet();
		}
	};
}
