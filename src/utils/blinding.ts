import { bytesToBigintLE } from './bytes';
import { BN254_R } from './crypto-constants';

/**
 * Generate a cryptographically random Poseidon blinding factor.
 *
 * Produces a uniform random value in [1, BN254_R) by reading 32 random bytes
 * and reducing mod BN254_R. The zero case is mapped to 1 to guarantee the
 * blinding factor is never zero.
 */
export function randomBlinding(): bigint {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    const n = bytesToBigintLE(buf);
    return n === 0n ? 1n : n % BN254_R;
}
