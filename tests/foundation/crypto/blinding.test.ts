/**
 * The blinding factor every note commitment mixes in.
 *
 * The property is narrow but load-bearing: a blinding must land in
 * [1, BN254_R). Zero would mean two notes of the same value to the same owner
 * commit identically, and anything at or above the field modulus is not a valid
 * field element at all.
 *
 * The multiple-of-modulus case is the one worth pinning down. It is
 * astronomically unlikely to be drawn at random, which is exactly why it
 * survived in the code: the guard was applied to the raw draw rather than to
 * the reduced value, so `BN254_R * 2` passed the non-zero check and then
 * reduced to zero.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBlinding } from '../../../src/foundation/crypto/blinding';
import { BN254_R } from '../../../src/foundation/crypto/constants';
import { bigintTo32Le } from '../../../src/foundation/encoding/bytes';

/** Forces the next `getRandomValues` to yield `value` as 32 little-endian bytes. */
function drawing(value: bigint) {
    return vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((buf: Uint8Array) => {
        buf.set(bigintTo32Le(value));
        return buf;
    }) as typeof crypto.getRandomValues);
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('randomBlinding', () => {
    it('stays inside the field', () => {
        for (let i = 0; i < 200; i++) {
            const blinding = randomBlinding();
            expect(blinding).toBeGreaterThan(0n);
            expect(blinding).toBeLessThan(BN254_R);
        }
    });

    it('does not repeat across draws', () => {
        const draws = new Set(Array.from({ length: 200 }, () => randomBlinding()));

        expect(draws.size).toBe(200);
    });

    it('reduces a draw at or above the modulus', () => {
        drawing(BN254_R + 5n);

        expect(randomBlinding()).toBe(5n);
    });

    it('maps a zero draw to 1', () => {
        drawing(0n);

        expect(randomBlinding()).toBe(1n);
    });

    it('maps a draw that REDUCES to zero to 1', () => {
        // A non-zero multiple of the modulus. Checking the raw draw for zero
        // instead of the reduced value lets this through as a zero blinding.
        drawing(BN254_R * 2n);

        expect(randomBlinding()).toBe(1n);
    });

    it('never returns zero for any multiple of the modulus that fits in 32 bytes', () => {
        for (let k = 1n; k <= 5n; k++) {
            drawing(BN254_R * k);
            expect(randomBlinding()).not.toBe(0n);
        }
    });

    it('reads exactly 32 bytes of randomness', () => {
        const spy = drawing(7n);

        randomBlinding();

        expect((spy.mock.calls[0]?.[0] as Uint8Array).length).toBe(32);
    });
});
