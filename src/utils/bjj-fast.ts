/**
 * bjj-fast — BabyJubJub scalar multiplication on @noble/curves.
 *
 * @zk-kit/baby-jubjub's mulPointEscalar is a plain double-and-add over raw
 * bigints. The wallet scan performs one variable-point mul PER POOL HINT,
 * which makes the EC math the dominant cost of a full rescan; noble is
 * roughly an order of magnitude faster on the same curve.
 *
 * Cost is dominated by the SCALAR's bit length, so figures measured with a
 * small scalar do not transfer. With a full-width scalar (a 247-bit ivsk, the
 * scan's actual case), measured on an M-series laptop under Node 22:
 *
 *   fastMulPoint, fresh point   ~1500 µs   ← the per-hint scan cost
 *   fastMulPoint, warm table     ~150 µs   ← same point reused (windows)
 *   fastMulBase                  ~180 µs   ← generator table, built once
 *   zk-kit mulPointEscalar     ~23000 µs
 *
 * The 10× gap between a fresh and a reused point is noble's wNAF table, built
 * lazily on a point's first multiplication. It cannot help the per-hint path
 * (the ephPk differs every hint, so the table would be built and thrown away
 * — measured 26× SLOWER that way), but it is why precomputed windows
 * (selfEph, pairwise) are worth building once and reusing.
 *
 * Scope: multiplication ONLY. Point packing stays on @zk-kit (its packed
 * format is the on-chain memo format and noble's toBytes is NOT compatible).
 * Results are byte-identical to zk-kit's — pinned by equivalence tests.
 *
 * Timing: multiplyUnsafe is variable-time, exactly like the zk-kit mul it
 * replaces — no constant-time regression is introduced here.
 */
import { edwards } from '@noble/curves/abstract/edwards.js';

/** BN254 scalar field prime (the BabyJubJub base field). */
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** Prime subgroup order (BABYJUB_SUBORDER). */
const N = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

const BjjPoint = edwards({
    p: P,
    n: N,
    h: 8n,
    a: 168700n,
    d: 168696n,
    Gx: 5299619240641551281634865583518297030282874472190772894086521144482721001553n,
    Gy: 16950150798460657717958625567821834550301663161624707787222815936182638968203n,
});

/** Affine point as zk-kit represents it. */
export type AffinePoint = [bigint, bigint];

/** Generator (Base8) multiplication — precomputed-table path. */
export function fastMulBase(scalar: bigint): AffinePoint {
    const s = scalar % N;
    if (s === 0n) return [0n, 1n];
    const { x, y } = BjjPoint.BASE.multiply(s).toAffine();
    return [x, y];
}

/** Variable-point multiplication — one-shot unsafe path. */
export function fastMulPoint(point: AffinePoint, scalar: bigint): AffinePoint {
    const s = scalar % N;
    if (s === 0n) return [0n, 1n];
    const { x, y } = BjjPoint.fromAffine({ x: point[0], y: point[1] }).multiplyUnsafe(s).toAffine();
    return [x, y];
}
