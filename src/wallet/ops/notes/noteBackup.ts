/**
 * CLOSED JSON backup of notes — the same notes moved between a user's devices as
 * a plain file, WITHOUT exposing any spending key.
 *
 * ## The idea
 *
 * A backup entry carries only what is already PUBLIC on chain: the commitment and
 * the encrypted memo. It contains no spending key, so the file is safe to hold
 * and even share — it grants nothing on its own.
 *
 * On import, the recipient DECRYPTS each memo with their own viewing key
 * (`importNotesFromBackup`). Decryption is the proof of ownership:
 *   - the memo decrypts → the note is theirs → a full spendable `ZkNote` is
 *     reconstructed, spending key and stealth key derived from their identity;
 *   - the memo does not decrypt → the note is someone else's → it is dropped.
 *
 * This is NOT a chain scan: only the N memos in the backup are tried, not the
 * whole pool. It moves notes between devices without re-scanning, and a note that
 * is not yours simply fails to import.
 *
 * ## What travels vs what does not
 *
 * Travels: `commitmentHex`, `encryptedMemo`, and `leafIndex` (informational).
 * Does NOT travel: value, ownerPk, blinding, spendingKey — all recovered by
 * decrypting the memo. The Merkle proof is re-fetched at spend time.
 */
import type { ZkNote, ScanCommitment } from '../../../protocol/types';
import { tryDecryptNote } from '../../../protocol/note/NoteDecryptor';
import { toHex } from '../../../foundation/encoding/hex';

/** Current backup format version. Bumped only if the entry shape changes. */
export const NOTE_BACKUP_VERSION = 1 as const;

/**
 * One note in a closed backup — public data only. Field names are short but not
 * cryptic; readability matters more than density in a file (unlike the QR path).
 */
export interface NoteBackupEntry {
    /** 0x-prefixed 32-byte LE commitment hex. */
    commitmentHex: string;
    /** 0x-prefixed encrypted memo hex (180 bytes). Decrypted on import. */
    encryptedMemo: string;
    /** Merkle leaf index, when known. Informational — spends re-fetch the proof. */
    leafIndex?: number;
}

export interface NoteBackup {
    v: typeof NOTE_BACKUP_VERSION;
    /** Export time (ms). Informational. */
    ts: number;
    notes: NoteBackupEntry[];
}

/** Keys the importer needs to prove ownership by decrypting each memo. */
export interface BackupImportKeys {
    /** 32-byte viewing secret key (ivsk). */
    viewingSecretKey: Uint8Array;
    /** Spending key scalar — folded into the derived stealth key / nullifier. */
    spendingKey: bigint;
    /** The importer's global owner pk (Ax), for stealth detection. */
    ownerPk: bigint;
}

function noteToBackupEntry(note: ZkNote): NoteBackupEntry {
    return {
        commitmentHex: note.commitmentHex,
        encryptedMemo: toHex(Uint8Array.from(note.memo)),
        ...(note.leafIndex !== undefined ? { leafIndex: note.leafIndex } : {}),
    };
}

/**
 * Encode notes into a closed JSON backup. Carries the memo, not the keys.
 * `now` is injectable for a deterministic export (tests).
 */
export function encodeNoteBackup(
    notes: ZkNote[],
    options: { now?: () => number } = {}
): NoteBackup {
    const now = options.now ?? Date.now;
    return {
        v: NOTE_BACKUP_VERSION,
        ts: now(),
        notes: notes.map(noteToBackupEntry),
    };
}

/**
 * Decode a JSON backup (string or object) into entries. Strict: a malformed
 * payload is rejected rather than partially imported.
 */
export function decodeNoteBackup(json: string | object): NoteBackupEntry[] {
    let payload: unknown;
    if (typeof json === 'string') {
        try {
            payload = JSON.parse(json);
        } catch {
            throw new Error('Note backup is not valid JSON.');
        }
    } else {
        payload = json;
    }

    const p = payload as Partial<NoteBackup>;
    if (p.v !== NOTE_BACKUP_VERSION) {
        throw new Error(`Unsupported note-backup version: ${String(p.v)}.`);
    }
    if (!Array.isArray(p.notes) || p.notes.some((n) => !isEntry(n))) {
        throw new Error('Note backup is missing required fields.');
    }
    return p.notes as NoteBackupEntry[];
}

/**
 * Import a closed backup: decrypt each entry's memo with the importer's keys and
 * return the notes that belong to them as full, spendable `ZkNote`s.
 *
 * Ownership is proven by decryption — an entry whose memo does not open under
 * these keys is silently skipped (it is not this user's note). No chain access:
 * only the backup's own memos are tried.
 */
export function importNotesFromBackup(
    entries: NoteBackupEntry[],
    keys: BackupImportKeys
): ZkNote[] {
    const out: ZkNote[] = [];
    for (const entry of entries) {
        const commitment: ScanCommitment = {
            commitmentHex: entry.commitmentHex,
            leafIndex: entry.leafIndex ?? -1,
            encryptedMemo: entry.encryptedMemo,
        };
        const note = tryDecryptNote(
            commitment,
            keys.viewingSecretKey,
            keys.spendingKey,
            keys.ownerPk
        );
        if (note) out.push(note);
    }
    return out;
}

/** Structural guard for one entry: commitment + memo present, leafIndex optional. */
function isEntry(value: unknown): value is NoteBackupEntry {
    if (typeof value !== 'object' || value === null) return false;
    const e = value as Record<string, unknown>;
    if (typeof e['commitmentHex'] !== 'string' || e['commitmentHex'].length === 0) return false;
    if (typeof e['encryptedMemo'] !== 'string' || e['encryptedMemo'].length === 0) return false;
    if ('leafIndex' in e && e['leafIndex'] !== undefined && typeof e['leafIndex'] !== 'number') {
        return false;
    }
    return true;
}
