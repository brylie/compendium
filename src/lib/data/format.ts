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

export function formatTimestamp(ms: number): string {
	return new Date(ms).toLocaleString();
}
