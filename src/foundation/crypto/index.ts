/**
 * Curve arithmetic, stealth derivation and the field constants they share.
 *
 * `bjj-fast` exists because the plain implementation is the scan's hot path:
 * one multiplication per hint over a whole pool.
 */
export { BN254_R, BABYJUB_SUBORDER } from './constants';
export { recoverOwnerPkPoint, unpackUsableViewingKey } from './bjj';
// The two halves of key validation: `unpackUsableViewingKey` for a PUBLIC key
// someone else chose, these for the SECRET bytes a caller supplies. Exported so
// a host can refuse bad key material at its own boundary instead of finding out
// several layers in.
export { assertSecretKeyBytes, isUsableSecretKey } from './keyGuards';
export { fastMulBase, fastMulPoint } from './bjj-fast';
export { deriveStealthOwnerPk, deriveStealthSk } from './stealth';
export { randomBlinding } from './blinding';
export type { CryptoKey } from './webcrypto';
