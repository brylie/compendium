/**
 * Server-owned local instance identity (#111). Distinct from a future
 * user-facing Space and from multi-tenant authentication — this exists so a
 * personal daily instance, a development instance, and test harnesses running
 * on one machine can be given genuinely different, explicitly configured
 * identities instead of every process silently defaulting to the same
 * hardcoded 'default' workspace. Read fresh on every call, not cached — a
 * test that sets/unsets the env var between runs must see the change
 * immediately.
 *
 * The 'default' fallback is a literal here, not imported from
 * workspace-store.ts's own DEFAULT_WORKSPACE_ID constant — that module
 * imports this one (to resolve its own default selector), so importing back
 * would be circular. Both must name the same literal; workspace-store.ts's
 * own constant stays the canonical export for every other caller.
 */
export function getInstanceWorkspaceId(): string {
	return process.env.COMPENDIUM_INSTANCE_ID ?? 'default';
}
