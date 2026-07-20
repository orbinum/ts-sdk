/**
 * bjj-fast — BabyJubJub scalar multiplication on @noble/curves.
 *
 * @zk-kit/baby-jubjub's mulPointEscalar is a plain double-and-add over raw
 * bigints (~1ms per mul in Node, several ms in a browser tab). The wallet
 * scan performs one variable-point mul PER POOL HINT, which made the EC math
 * ~90% of a full rescan. noble's multiplyUnsafe on the same curve is ~17×
 * faster (measured 0.056ms vs 0.94ms per mul), and its generator multiply
 * uses precomputed tables (~11× faster).
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

/** Generator (Base8) multiplication — precomputed-table path (~0.09ms). */
export function fastMulBase(scalar: bigint): AffinePoint {
    const s = scalar % N;
    if (s === 0n) return [0n, 1n];
    const { x, y } = BjjPoint.BASE.multiply(s).toAffine();
    return [x, y];
}

/** Variable-point multiplication — one-shot unsafe path (~0.06ms). */
export function fastMulPoint(point: AffinePoint, scalar: bigint): AffinePoint {
    const s = scalar % N;
    if (s === 0n) return [0n, 1n];
    const { x, y } = BjjPoint.fromAffine({ x: point[0], y: point[1] }).multiplyUnsafe(s).toAffine();
    return [x, y];
}
