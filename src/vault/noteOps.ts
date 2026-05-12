/**
 * noteOps
 *
 * Pure protocol-level operations on vault notes.
 * No Zustand, no IndexedDB — pure data transformations.
 */

import type { ZkNote } from '../shielded-pool/protocol/types';
import { encryptJson, decryptJson } from './VaultCrypto';
import type { EncryptedNoteRecord, NoteStatusUpdate } from './types';

/**
 * Merges a NoteStatusUpdate into a ZkNote, applying defaults for missing fields.
 * Returns a new note object — does not mutate the original.
 */
export function applyNoteStatus(note: ZkNote, status?: NoteStatusUpdate): ZkNote {
    return {
        ...note,
        spent: status?.spent ?? note.spent ?? false,
        spentAt: status?.spentAt ?? note.spentAt ?? null,
    };
}

/**
 * Encrypts a ZkNote into an EncryptedNoteRecord using AES-GCM.
 * The commitmentHex, nullifierHex, and assetId are stored in plaintext
 * for efficient filtering without requiring vault unlock.
 */
export async function encryptNote(key: CryptoKey, note: ZkNote): Promise<EncryptedNoteRecord> {
    const { iv, ciphertext } = await encryptJson(key, note);
    return {
        commitmentHex: note.commitmentHex,
        iv,
        ciphertext,
        nullifierHex: note.nullifierHex,
        assetId: note.assetId.toString(),
        spent: note.spent,
        spentAt: note.spentAt,
        updatedAt: Date.now(),
    };
}

/**
 * Decrypts an EncryptedNoteRecord back into a ZkNote using AES-GCM.
 * Applies the record's spent/spentAt metadata onto the decrypted note.
 * Throws DOMException on authentication failure (wrong key or corrupted data).
 */
export async function decryptNoteRecord(key: CryptoKey, rec: EncryptedNoteRecord): Promise<ZkNote> {
    const note = (await decryptJson(key, rec.iv, rec.ciphertext)) as ZkNote;
    return applyNoteStatus(note, {
        ...(rec.spent !== undefined && { spent: rec.spent }),
        spentAt: rec.spentAt ?? null,
    });
}
