/** Thrown when a requested Document, Collection, record, property, or select option doesn't exist. */
export class NotFoundError extends Error {}
/** Thrown when an actor attempts a mutation they aren't permitted to make. */
export class PermissionError extends Error {}
/** Thrown when an input value fails a domain rule (e.g. a blank/duplicate select-option label, a field type that can't be the primary field). */
export class ValidationError extends Error {}
