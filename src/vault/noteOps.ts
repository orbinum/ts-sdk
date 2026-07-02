/**
 * noteOps
 *
 * Pure protocol-level operations on vault notes.
 * No Zustand, no IndexedDB — pure data transformations.
 */

import type { ZkNote } from '../shielded-pool/protocol/types';
import { encryptJson, decryptJson, blindTag } from './VaultCrypto';
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
 * Encrypts a ZkNote into a v2 EncryptedNoteRecord.
 *
 * The full note (values, secrets) is AES-GCM encrypted under `key`; the note
 * identifiers (commitment, nullifier, asset) are stored as BLIND TAGS under
 * `blindKey` instead of plaintext — a storage dump reveals nothing linkable to
 * chain activity, while equality lookups still work (compare tags).
 */
export async function encryptNote(
    key: CryptoKey,
    blindKey: CryptoKey,
    note: ZkNote
): Promise<EncryptedNoteRecord> {
    const { iv, ciphertext } = await encryptJson(key, note);
    const [commitmentTag, nullifierTag, assetTag] = await Promise.all([
        blindTag(blindKey, note.commitmentHex),
        blindTag(blindKey, note.nullifierHex),
        blindTag(blindKey, note.assetId.toString()),
    ]);
    return {
        commitmentTag,
        iv,
        ciphertext,
        nullifierTag,
        assetTag,
        spent: note.spent,
        spentAt: note.spentAt,
        updatedAt: Date.now(),
    };
}

/**
 * Decrypts a note record back into a ZkNote.
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

/**
 * Blind tag for a note identifier hex — use to build the storage key or to
 * look a record up by commitment/nullifier without exposing the raw hex.
 */
export async function noteBlindTag(blindKey: CryptoKey, hex: string): Promise<string> {
    return blindTag(blindKey, hex);
}
