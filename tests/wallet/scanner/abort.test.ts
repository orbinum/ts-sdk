/**
 * The abort shape every phase throws.
 *
 * The point is portability: the DOM reports an abort as a `DOMException`, and a
 * runtime without that class must still produce something the same `catch`
 * recognises. Matching on `name` rather than on the class is what makes a scan
 * abort identically in a browser, a worker and a Node process — so the test that
 * matters is the one that removes `DOMException` and checks the fallback still
 * satisfies `isAbortError`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { scanAbortError, isAbortError } from '../../../src/foundation/errors/abort';

describe('scanAbortError', () => {
    it('is named AbortError', () => {
        expect(scanAbortError().name).toBe('AbortError');
    });

    it('is an Error, so a catch that rethrows non-Errors passes it through', () => {
        expect(scanAbortError()).toBeInstanceOf(Error);
    });

    it('carries a message', () => {
        expect(scanAbortError().message).toBe('Scan aborted');
    });
});

describe('isAbortError', () => {
    it('recognises what scanAbortError produces', () => {
        expect(isAbortError(scanAbortError())).toBe(true);
    });

    it('recognises a DOM AbortError from any other source', () => {
        // A fetch aborted by the host's own signal arrives this way, and the
        // scan must treat it as an abort rather than as a feed failure.
        const err = new Error('aborted elsewhere');
        err.name = 'AbortError';

        expect(isAbortError(err)).toBe(true);
    });

    it('rejects an ordinary error', () => {
        expect(isAbortError(new Error('network down'))).toBe(false);
    });

    it('rejects non-Error values', () => {
        expect(isAbortError('AbortError')).toBe(false);
        expect(isAbortError({ name: 'AbortError' })).toBe(false);
        expect(isAbortError(null)).toBe(false);
        expect(isAbortError(undefined)).toBe(false);
    });
});

describe('without DOMException', () => {
    const original = globalThis.DOMException;

    afterEach(() => {
        if (original === undefined) delete (globalThis as { DOMException?: unknown }).DOMException;
        else globalThis.DOMException = original;
    });

    it('falls back to a plain named Error that isAbortError still accepts', () => {
        // The whole reason this helper exists. A runtime lacking DOMException
        // must not silently produce something the phases fail to recognise —
        // that would turn an abort into a reported scan failure.
        delete (globalThis as { DOMException?: unknown }).DOMException;

        const err = scanAbortError();

        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('AbortError');
        expect(isAbortError(err)).toBe(true);
    });
});
