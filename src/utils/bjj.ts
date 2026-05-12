import { mulPointEscalar } from '@zk-kit/baby-jubjub';
import { BABYJUB_SUBORDER, BN254_R } from './crypto-constants';

// BJJ curve constants for point recovery (standard Baby JubJub, same as @zk-kit/baby-jubjub).
// Twisted Edwards form: a*x² + y² = 1 + d*x²*y²
// BN254_R is the BN254 scalar field prime — identical to the Baby JubJub field prime.
const BJJ_A = 168700n;
const BJJ_D = 168696n;

function _modpow(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = 1n;
    base = base % mod;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % mod;
        exp >>= 1n;
        base = (base * base) % mod;
    }
    return result;
}

/**
 * Compute the modular square root using the Tonelli-Shanks algorithm.
 * Returns null if y2 is not a quadratic residue mod P.
 * Handles all primes (including P ≡ 1 mod 4, as is the case for BN254).
 */
function _sqrtModP(y2: bigint): bigint | null {
    if (y2 === 0n) return 0n;
    if (_modpow(y2, (BN254_R - 1n) / 2n, BN254_R) !== 1n) return null;

    // Factor BN254_R - 1 = 2^s * q  (q odd).
    let s = 0n;
    let q = BN254_R - 1n;
    while ((q & 1n) === 0n) {
        q >>= 1n;
        s++;
    }

    // Simple case: P ≡ 3 (mod 4) → s = 1.
    if (s === 1n) return _modpow(y2, (BN254_R + 1n) / 4n, BN254_R);

    // Find a quadratic non-residue z.
    let z = 2n;
    while (_modpow(z, (BN254_R - 1n) / 2n, BN254_R) === 1n) z++;

    // Tonelli-Shanks iterations.
    let m = s;
    let c = _modpow(z, q, BN254_R);
    let t = _modpow(y2, q, BN254_R);
    let r = _modpow(y2, (q + 1n) / 2n, BN254_R);

    for (;;) {
        if (t === 1n) return r;
        let i = 1n;
        let tmp = (t * t) % BN254_R;
        while (tmp !== 1n) {
            tmp = (tmp * tmp) % BN254_R;
            i++;
        }
        const b = _modpow(c, 1n << (m - i - 1n), BN254_R);
        m = i;
        c = (b * b) % BN254_R;
        t = (t * c) % BN254_R;
        r = (r * b) % BN254_R;
    }
}

/**
 * Recover the BabyJubJub [Ax, Ay] point from an Ax coordinate.
 *
 * Uses the standard twisted Edwards curve equation: a*x² + y² = 1 + d*x²*y²
 * with a=168700, d=168696 (same as @zk-kit/baby-jubjub). Solving for y²:
 *   y² = (1 - a*x²) / (1 - d*x²)  mod P
 *
 * The square root is computed via Tonelli-Shanks (required since P ≡ 1 mod 4).
 * Returns the point with the canonical (smaller) y, or null if Ax is not on the curve.
 */
export function recoverOwnerPkPoint(ax: bigint): [bigint, bigint] | null {
    const x2 = (ax * ax) % BN254_R;
    const num = (((1n - BJJ_A * x2) % BN254_R) + BN254_R) % BN254_R;
    const den = (((1n - BJJ_D * x2) % BN254_R) + BN254_R) % BN254_R;
    if (den === 0n) return null;

    const denInv = _modpow(den, BN254_R - 2n, BN254_R);
    const y2 = (num * denInv) % BN254_R;

    const y = _sqrtModP(y2);
    if (y === null) return null;

    const yAlt = BN254_R - y;

    // Determine which y places the point in the prime-order subgroup.
    // The identity element in Baby JubJub (twisted Edwards) is (0n, 1n).
    // A point P is in the prime subgroup iff BABYJUB_SUBORDER × P = identity.
    // For a valid ownerPk exactly one of y / yAlt satisfies this.
    try {
        const check = mulPointEscalar([ax, y] as [bigint, bigint], BABYJUB_SUBORDER);
        return check[0] === 0n && check[1] === 1n ? [ax, y] : [ax, yAlt];
    } catch {
        return [ax, yAlt];
    }
}
