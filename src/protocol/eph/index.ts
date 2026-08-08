/**
 * Deterministic ephemeral keys — the two cases where the ephSk can be derived
 * instead of drawn at random, so the receiver recognises a note by a hash
 * lookup rather than one elliptic-curve multiplication per hint.
 *
 * Both carry the same hazard: an index used twice republishes the same ephPk
 * and publicly links the two notes. Both are therefore pure functions of
 * (secret, range) — the counter is the caller's to persist, and
 * `vault/storage/ephemeralIndex.ts` is what reserves it safely.
 */
export { deriveSelfEphSk, selfEphWindow } from './selfEph';
export type { SelfEphWindowEntry } from './selfEph';
export { derivePairwiseSharedSecret, derivePairwiseEphSk, pairwiseEphWindow } from './pairwiseEph';
export type { PairwiseEphWindowEntry } from './pairwiseEph';
