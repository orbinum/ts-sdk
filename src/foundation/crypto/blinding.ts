import { bytesToBigintLE } from '../encoding/bytes';
import { BN254_R } from './constants';

/**
 * A cryptographically random Poseidon blinding factor in [1, BN254_R).
 *
 * The blinding is what makes a commitment hide its value: two notes of the same
 * amount to the same owner must not produce the same commitment. A zero
 * blinding would weaken that, so it is excluded.
 *
 * The reduction happens BEFORE the zero check, not after. Checking the raw
 * 32-byte draw instead would let any non-zero multiple of BN254_R through —
 * `n % BN254_R` is then 0, and the guard the comment promises never fires.
 */
export function randomBlinding(): bigint {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    const reduced = bytesToBigintLE(buf) % BN254_R;
    return reduced === 0n ? 1n : reduced;
}
