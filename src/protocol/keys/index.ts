/**
 * The private identity: what the user signs, and every key that comes out of it.
 *
 * ```
 * SpendingKeyRequest.ts     the MESSAGE a wallet signs, and its origin binding
 * spendingKeyDerivation.ts  signature → masterBytes, the root of everything
 * PrivacyKeys.ts            masterBytes → the v3 branches (spend / ivk / ovk)
 * PrivacyKeyManager.ts      one loaded identity, in memory, plus its address
 * accountIdentity.ts        the account spelling the derivation keys by
 * ```
 *
 * TWO GENERATIONS ARE EXPORTED HERE, and they are not interchangeable:
 *
 *   - `deriveSpendingKeyV3` / `deriveViewingSecretKeyV3` /
 *     `deriveOutgoingViewingKeyV3` — siblings of the master, none derived from
 *     another. This is what a wallet uses.
 *   - `deriveSpendingKeyFromMaster` / `deriveViewingSecretKey` — the older
 *     scheme, where the viewing key hung off the spending key. Kept for reading
 *     material derived under it; mixing the two yields a second identity whose
 *     notes the first cannot see.
 */
export {
    deriveSpendingKeyTypedData,
    deriveSpendingKeyMessageV2,
    SPENDING_KEY_VERIFYING_CONTRACT,
    SPENDING_KEY_CANONICAL_ORIGIN,
    SPENDING_KEY_WARNING,
} from './SpendingKeyRequest';
export type { SpendingKeyTypedData } from './SpendingKeyRequest';
export { canonicalAccountId } from './accountIdentity';
export {
    deriveSpendingKeyFromMaster,
    deriveViewingSecretKey,
    deriveSpendingKeyV3,
    deriveViewingSecretKeyV3,
    deriveOutgoingViewingKeyV3,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from './PrivacyKeys';
export { PrivacyKeyManager } from './PrivacyKeyManager';
export {
    deriveMasterKeyBytes,
    deriveSpendingKeyFromSignature,
    MIN_SIGNATURE_BYTES,
} from './spendingKeyDerivation';
