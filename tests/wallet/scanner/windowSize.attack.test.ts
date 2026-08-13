/**
 * Attacks on the discovery-window size.
 *
 * `windowSizeForCounter` turns a stored counter into a number of ephemeral keys
 * to precompute, and each one costs two EC muls plus a map entry. So the
 * counter is not just an index here — it is a loop bound the scanner obeys.
 *
 * Two ways that hurts, and only one needs a corrupt vault:
 *
 *   - a counter that is `NaN` or `Infinity` — from a restore or a hand-edited
 *     backup — either empties the window or never finishes building it;
 *   - a counter that is merely LARGE, which a long-lived wallet reaches on its
 *     own, asks for a window proportional to it and hangs the worker.
 *
 * The window is an optimisation: skipping it costs a trial decrypt per note,
 * which is slow but correct. Hanging the scan is not.
 */
import { describe, it, expect } from 'vitest';
import { windowSizeForCounter, MAX_EPH_WINDOW } from '../../../src/wallet/scanner/selfEphGap';
import { SELF_EPH_WINDOW } from '../../../src/wallet/worker/kernel/types';

describe('a hostile counter cannot break the window size', () => {
    it('never returns a non-finite size', () => {
        // NaN makes `i < from + count` false at once, so the window comes back
        // EMPTY and every note silently falls to the slow path. Infinity makes
        // the same loop never terminate.
        for (const bad of [NaN, Infinity, -Infinity]) {
            const size = windowSizeForCounter(bad);
            expect(Number.isFinite(size)).toBe(true);
            expect(size).toBeGreaterThanOrEqual(SELF_EPH_WINDOW);
        }
    });

    it('never returns a size below the default', () => {
        // A negative or fractional counter must not shrink the window below the
        // default: indexes inside it would drop off the fast path.
        for (const bad of [-1, -1e9, 2.5, '3' as unknown as number, null as unknown as number]) {
            expect(windowSizeForCounter(bad)).toBeGreaterThanOrEqual(SELF_EPH_WINDOW);
        }
    });

    it('caps a huge counter instead of asking for a huge precompute', () => {
        // THE HANG. This needs no corruption at all — a wallet that really used
        // a billion indexes reports a billion, and the window builder would run
        // two EC muls for each. The cap turns an unusable scan into a slower one.
        for (const huge of [1e9, Number.MAX_SAFE_INTEGER, 2 ** 32]) {
            expect(windowSizeForCounter(huge)).toBeLessThanOrEqual(MAX_EPH_WINDOW);
        }
    });

    it('the cap is still a whole number of windows', () => {
        // The builder walks [0, size), and callers reason in window multiples.
        expect(MAX_EPH_WINDOW % SELF_EPH_WINDOW).toBe(0);
        expect(windowSizeForCounter(1e9) % SELF_EPH_WINDOW).toBe(0);
    });

    it('a normal counter is unaffected by any of the guards', () => {
        // The guards must not change behaviour for real wallets — that would be
        // a fast-path regression reached by the fix itself.
        expect(windowSizeForCounter(0)).toBe(SELF_EPH_WINDOW);
        expect(windowSizeForCounter(500)).toBe(SELF_EPH_WINDOW);
        expect(windowSizeForCounter(SELF_EPH_WINDOW - 1)).toBe(SELF_EPH_WINDOW * 2);
        expect(windowSizeForCounter(SELF_EPH_WINDOW * 2 + 5)).toBe(SELF_EPH_WINDOW * 3);
    });
});
