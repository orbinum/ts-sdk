/**
 * Persistence: the contract a backend implements, the records that cross it,
 * and the config a wallet keeps beside its notes.
 *
 * Depends only on `crypto/` types indirectly — a backend never sees a plaintext
 * note, which is what makes an untrusted or remote one viable.
 */
export type { EncryptedNoteRecord, NoteStatusUpdate } from './records';
export type {
    VaultStorage,
    NoteStorage,
    NullifierCache,
    TxHistoryStore,
    VaultConfigRecord,
    EncryptedTxRecord,
    CachedNullifier,
    NullifierSyncMeta,
    SpendDetails,
} from './contract';
export { MemoryVaultStorage } from './MemoryVaultStorage';
export { buildConfig, normalizeChainFingerprint, VAULT_SCHEMA_VERSION } from './config';
export { reserveSelfEphIndex, reservePairwiseIndex } from './ephemeralIndex';
