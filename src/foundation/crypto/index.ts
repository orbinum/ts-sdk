/**
 * Curve arithmetic, stealth derivation and the field constants they share.
 *
 * `bjj-fast` exists because the plain implementation is the scan's hot path:
 * one multiplication per hint over a whole pool.
 */
export { BN254_R, BABYJUB_SUBORDER } from './constants';
export { recoverOwnerPkPoint } from './bjj';
export { fastMulBase, fastMulPoint } from './bjj-fast';
export { deriveStealthOwnerPk, deriveStealthSk } from './stealth';
export { randomBlinding } from './blinding';
export type { CryptoKey } from './webcrypto';
