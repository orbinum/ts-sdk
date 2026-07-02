/**
 * Vault protocol types.
 *
 * These types define the storage contract for vault note records.
 * Any backend (IndexedDB, SQLite, remote…) must produce/consume this shape
 * so that encryptNote / decryptNoteRecord work without modification.
 */

/**
 * A single encrypted note record as stored in the vault backend.
 *
 * Note identifiers are BLINDED — stored as HMAC tags derived from the vault
 * blind key, not the raw on-chain hex. A storage dump reveals no
 * commitment/nullifier/asset that could be linked to chain activity, yet
 * equality lookups (find-my-note) still work by comparing tags. `spent` /
 * `spentAt` stay plaintext: they're local flags with no on-chain linkage.
 */
export interface EncryptedNoteRecord {
    /** Primary key — blinded commitment tag: HMAC(blindKey, commitmentHex). */
    commitmentTag: string;
    /** AES-GCM IV for this record — base64 */
    iv: string;
    /** AES-GCM ciphertext of the full ZkNote JSON — base64 */
    ciphertext: string;
    /** Blinded nullifier tag: HMAC(blindKey, nullifierHex). Quick spent-check. */
    nullifierTag: string;
    /** Blinded asset tag: HMAC(blindKey, assetId). Filter by asset without unlock. */
    assetTag: string;
    /** Whether the note has already been spent/nullified on-chain. */
    spent?: boolean;
    /** When the app marked the note as spent locally, if known. */
    spentAt?: number | null;
    updatedAt: number;
}

/** Partial update applied to a note's spent status without re-encrypting the full payload. */
export interface NoteStatusUpdate {
    spent?: boolean;
    spentAt?: number | null;
}
