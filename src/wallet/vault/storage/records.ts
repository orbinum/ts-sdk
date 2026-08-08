/**
 * The shape a note takes at rest.
 *
 * Any backend — IndexedDB, SQLite, remote — produces and consumes exactly this,
 * so `encryptNote` / `decryptNoteRecord` work against all of them unmodified.
 */

/**
 * One encrypted note as stored.
 *
 * Identifiers are BLINDED: stored as HMAC tags under the vault blind key, never
 * the raw on-chain hex. A storage dump therefore reveals no commitment,
 * nullifier or asset that could be linked to chain activity, while equality
 * lookups still work by comparing tags.
 *
 * `spent` / `spentAt` stay plaintext deliberately — they are local flags with
 * no on-chain linkage, and keeping them readable lets a backend filter spent
 * notes without unlocking the vault.
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
