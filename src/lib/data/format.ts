import type { ActorId } from './types';

export function formatActor(actor: ActorId): string {
	switch (actor.kind) {
		case 'human':
			return actor.userId === 'local' ? 'You' : actor.userId;
		case 'agent':
			return actor.name;
		case 'human-via-client':
			return `${actor.userId} · via ${actor.client}`;
	}
}

/** Stable identity string for an actor, distinct from formatActor's display text — used to tell "same actor" from "a different actor with the same display name" apart. */
export function actorKey(actor: ActorId): string {
	switch (actor.kind) {
		case 'human':
			return `human:${actor.userId}`;
		case 'agent':
			return `agent:${actor.agentId}`;
		case 'human-via-client':
			return `human-via-client:${actor.userId}:${actor.client}`;
	}
}

export function formatTimestamp(ms: number): string {
	return new Date(ms).toLocaleString();
}
