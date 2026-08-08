/**
 * Aborting a scan, portably.
 *
 * The DOM reports an abort as a `DOMException` named `AbortError`; Node before
 * that class was global has no such type. Both forms carry `name`, so matching
 * on it — never on the class — makes a scan abort identically in a browser tab,
 * a worker, and a Node process.
 *
 * Lives on its own rather than inside a phase: every phase can be aborted, and
 * hanging the helper off phase 1 made phases 2 and 3 import upward from it for
 * a reason unrelated to collecting hints.
 */

/** The error a scan throws when its signal is aborted. */
export function scanAbortError(): Error {
    if (typeof DOMException !== 'undefined') {
        return new DOMException('Scan aborted', 'AbortError') as unknown as Error;
    }
    const err = new Error('Scan aborted');
    err.name = 'AbortError';
    return err;
}

/** Whether a thrown value is an abort, in either of the forms above. */
export function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === 'AbortError';
}
