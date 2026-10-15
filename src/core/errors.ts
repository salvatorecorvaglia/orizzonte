/**
 * Turns a thrown value into the text shown to the user.
 *
 * `throw` accepts anything, so a caught value is not necessarily an `Error`.
 * The host had three identical copies of this; one definition keeps their
 * wording from drifting.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for the rejection an aborted fetch or scan produces. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
