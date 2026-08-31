// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { RequestContext } from '$lib/server/request-context';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			requestContext: RequestContext;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
