/**
 * Deterministic ephemeral keys — the three cases where the ephSk can be derived
 * instead of drawn at random, so a note is recognised by hash lookup rather
 * than one elliptic-curve multiplication per hint:
 *
 *   - `selfEph`     — notes the wallet made for itself, off its viewing key
 *   - `pairwiseEph` — notes from a counterparty already known, off a shared secret
 *   - `outgoingEph` — notes the wallet SENT, off its outgoing viewing key
 *
 * All three carry the same hazard: an index used twice republishes an ephPk and
 * publicly links the two notes. All three are therefore pure functions of
 * (secret, range) — the counter is the caller's to persist, and
 * `wallet/vault/storage/ephemeralIndex.ts` reserves it safely.
 */
export { deriveSelfEphSk, selfEphWindow } from './selfEph';
export type { SelfEphWindowEntry } from './selfEph';
export { derivePairwiseSharedSecret, derivePairwiseEphSk, pairwiseEphWindow } from './pairwiseEph';
export type { PairwiseEphWindowEntry } from './pairwiseEph';
export {
    deriveOutgoingEphSk,
    deriveOutgoingEphPk,
    deriveOutgoingSharedSecret,
    outgoingEphWindow,
    reconstructOutgoingIndex,
} from './outgoingEph';
export type { OutgoingEphWindowEntry } from './outgoingEph';
