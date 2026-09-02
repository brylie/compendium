/**
 * Reads one FormData field as a string, treating a non-string value (a
 * submitted File, for a field that expects plain text) as absent rather than
 * stringifying it — `String(aFile)` silently produces `"[object File]"`
 * instead of the field's real content, which a caller's own blank-value
 * check (`if (!clientLabel) return fail(400, ...)`) would otherwise miss.
 */
export function formString(value: FormDataEntryValue | null): string {
	return typeof value === 'string' ? value : '';
}
