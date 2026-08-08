/**
 * Clearing the discovery window.
 *
 * The window is a module-level cache holding one ECDH shared secret per index —
 * material derived from the wallet's viewing key. It is keyed by spending key,
 * so it can never serve a different identity, but "cannot be misused" is not
 * "is gone": after a lock the session keys are dropped while ~100 KB of derived
 * secrets stay reachable, and on a main-thread pool that is the page's heap.
 *
 * There is no way to inspect the cache from outside, so these tests measure the
 * rebuild instead: a populated window answers immediately, a cleared one has to
 * redo the elliptic-curve precompute.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { decryptHintBatch, clearKnownEphWindow } from '../../../../src/index';
import { createDecryptPool } from '../../../../src/index';
import { deriveViewingSecretKey, deriveOwnerPk } from '../../../../src/protocol/keys/PrivacyKeys';
import type { ScanKeys } from '../../../../src/index';

const SPENDING_KEY = 12345678901234567890n;

const keys = (): ScanKeys => ({
    viewingKey: deriveViewingSecretKey(SPENDING_KEY),
    spendingKey: SPENDING_KEY,
    ownerPk: deriveOwnerPk(SPENDING_KEY),
    selfEph: true,
    selfEphWindowSize: 64,
});

/** Milliseconds one batch takes — dominated by the window build when cold. */
function timeOneBatch(): number {
    const started = performance.now();
    decryptHintBatch([], keys());
    return performance.now() - started;
}

/**
 * A cold call rebuilds the window and is far slower than a warm one. The ratio
 * is large (EC precompute vs a map hit), so a loose factor keeps this honest
 * without making it flaky on a busy machine.
 */
const REBUILD_FACTOR = 3;

describe('clearKnownEphWindow', () => {
    beforeEach(() => {
        clearKnownEphWindow();
    });

    it('caches the window across batches', () => {
        const cold = timeOneBatch();
        const warm = timeOneBatch();

        expect(warm).toBeLessThan(cold / REBUILD_FACTOR);
    });

    it('forces a rebuild, which is what proves the secrets were dropped', () => {
        timeOneBatch();
        const warm = timeOneBatch();

        clearKnownEphWindow();
        const afterClear = timeOneBatch();

        expect(afterClear).toBeGreaterThan(warm * REBUILD_FACTOR);
    });

    it('is safe to call when nothing is cached', () => {
        expect(() => {
            clearKnownEphWindow();
            clearKnownEphWindow();
        }).not.toThrow();
    });
});

describe('main-thread pool terminate', () => {
    beforeEach(() => {
        clearKnownEphWindow();
    });

    it('drops the window, since there is no worker realm to discard', async () => {
        // The worker pool gets this for free — killing a worker takes its heap
        // with it. The main-thread pool shares the caller's heap, so unless
        // terminate() clears the cache the secrets simply stay there.
        const pool = createDecryptPool({ factory: null });
        // A non-empty batch: the pool's loop never runs for zero hints, so an
        // empty call would leave the window unbuilt and the timing meaningless.
        await pool.decryptBatch(
            [{ commitmentHex: '0xc1', leafIndex: 0, encryptedMemo: null }],
            keys()
        );
        const warm = timeOneBatch();

        pool.terminate();

        expect(timeOneBatch()).toBeGreaterThan(warm * REBUILD_FACTOR);
    });
});
