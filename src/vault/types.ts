/**
 * Vault protocol types.
 *
 * These types define the storage contract for vault note records.
 * Any backend (IndexedDB, SQLite, remote…) must produce/consume this shape
 * so that encryptNote / decryptNoteRecord work without modification.
 */

/** A single encrypted note record as stored in the vault backend. */
export interface EncryptedNoteRecord {
    /** Primary key — note commitmentHex */
    commitmentHex: string;
    /** AES-GCM IV for this record — base64 */
    iv: string;
    /** AES-GCM ciphertext of the full ZkNote JSON — base64 */
    ciphertext: string;
    /** Unencrypted nullifierHex for quick spent-check without unlocking */
    nullifierHex: string;
    /** Unencrypted assetId (string form of bigint) for filtering */
    assetId: string;
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
