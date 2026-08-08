/**
 * Aborting a scan on a runtime without `DOMException`.
 *
 * The pool used to construct `new DOMException('Scan aborted', 'AbortError')`
 * directly. React Native and some embedded engines do not define that global,
 * so cancelling a scan there threw `ReferenceError: DOMException is not
 * defined` — and `isAbortError()` said false, which means every caller read a
 * user cancellation as a genuine scan failure.
 *
 * `scanAbortError()` already solved this for the scanner; the pool now uses it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createDecryptPool, DECRYPT_YIELD_EVERY } from '../../../../src/index';
import { isAbortError } from '../../../../src/foundation/errors/abort';
import type { ScanKeys } from '../../../../src/index';
import type { ScanCommitment } from '../../../../src/protocol/types';

const keys: ScanKeys = {
    viewingKey: new Uint8Array(32),
    spendingKey: 1n,
    ownerPk: 1n,
};

/** More than one burst, so the loop reaches its mid-flight abort check. */
const hints: ScanCommitment[] = Array.from({ length: DECRYPT_YIELD_EVERY * 3 }, (_, i) => ({
    commitmentHex: `0x${i}`,
    leafIndex: i,
    encryptedMemo: null,
}));

const aborted = () => {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
};

describe('abort without DOMException', () => {
    const saved = globalThis.DOMException;

    afterEach(() => {
        globalThis.DOMException = saved;
    });

    it('throws an error isAbortError recognises', async () => {
        delete (globalThis as { DOMException?: unknown }).DOMException;
        const pool = createDecryptPool({ factory: null });

        const err = await pool.decryptBatch(hints, keys, aborted()).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(Error);
        expect(isAbortError(err)).toBe(true);
    });

    it('does not throw a ReferenceError for the missing global', async () => {
        // The actual regression: a ReferenceError here reads as "the scan
        // crashed", not "the user cancelled".
        delete (globalThis as { DOMException?: unknown }).DOMException;
        const pool = createDecryptPool({ factory: null });

        const err = await pool.decryptBatch(hints, keys, aborted()).catch((e: unknown) => e);

        expect(err).not.toBeInstanceOf(ReferenceError);
    });

    it('still aborts cleanly where DOMException does exist', async () => {
        const pool = createDecryptPool({ factory: null });

        const err = await pool.decryptBatch(hints, keys, aborted()).catch((e: unknown) => e);

        expect(isAbortError(err)).toBe(true);
    });
});
