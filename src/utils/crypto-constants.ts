/**
 * BN254 (alt_bn128) scalar field prime.
 *
 * Used as the modulus for Poseidon blinding factors: blinding ∈ [1, BN254_R).
 * A random 32-byte value reduced mod BN254_R gives a uniform blinding factor.
 */
export const BN254_R =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Baby JubJub prime subgroup order.
 *
 * Spending keys (circuit scalars) MUST be in [1, BABYJUB_SUBORDER).
 * circomlib's BabyPbk uses Num2Bits(253) which asserts sk < 2^253.
 * BABYJUB_SUBORDER < 2^252 < 2^253 satisfies both the curve arithmetic
 * requirement and the circuit constraint.
 */
export const BABYJUB_SUBORDER =
    2736030358979909402780800718157159386076813972158567259200215660948447373041n;
