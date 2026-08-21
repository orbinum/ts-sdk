/**
 * CLOSED JSON backup: notes moved between a user's devices as a plain file,
 * WITHOUT exposing any spending key.
 *
 * An entry carries only what is already PUBLIC on chain — the commitment and
 * the encrypted memo — so the file grants nothing on its own.
 *
 * DECRYPTION IS THE PROOF OF OWNERSHIP. On import each memo is opened with the
 * importer's viewing key: one that opens rebuilds a full spendable `ZkNote`
 * (spending and stealth keys derived from their identity); one that does not is
 * someone else's note and is dropped.
 *
 * Not a chain scan — only the N memos in the file are tried, which is what lets
 * a device restore without re-scanning the pool.
 *
 * Travels: `commitmentHex`, `encryptedMemo`, `leafIndex` (informational).
 * Recovered from the memo: value, ownerPk, blinding, spendingKey. The Merkle
 * proof is re-fetched at spend time.
 */
import type { ZkNote, ScanCommitment } from '../../../protocol/types';
import { tryDecryptNote } from '../../../protocol/note/NoteDecryptor';
import { assertSecretKeyBytes } from '../../../foundation/crypto/keyGuards';
import { toHex, isHexOfLength } from '../../../foundation/encoding/hex';
import { ENCRYPTED_MEMO_SIZE } from '../../../protocol/memo/EncryptedMemo';
import { isValidLeafIndex } from '../../../protocol/spend/coinSelection';

/** Current backup format version. Bumped only if the entry shape changes. */
export const NOTE_BACKUP_VERSION = 1 as const;

/** One note in a closed backup — public data only. */
export interface NoteBackupEntry {
    /** 0x-prefixed 32-byte LE commitment hex. */
    commitmentHex: string;
    /** 0x-prefixed encrypted memo hex (180 bytes). Decrypted on import. */
    encryptedMemo: string;
    /** Merkle leaf index, when known. Informational — spends re-fetch the proof. */
    leafIndex?: number;
    /**
     * Whether the note was already spent when exported. A local status flag (not
     * a key or secret), carried so a restored vault separates available from spent
     * without a chain round-trip. A host may still reconcile against the chain
     * afterward — this is a fast, possibly-stale hint, not the source of truth.
     */
    spent?: boolean;
    /** Local timestamp the note was marked spent, when known. */
    spentAt?: number | null;
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
        spent: note.spent,
        spentAt: note.spentAt,
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
 *
 * The decrypted note is reconstructed as unspent; the entry's `spent`/`spentAt`
 * flags are then applied so a restored vault separates available from spent. A
 * host may reconcile against the chain afterward if the backup could be stale.
 */
export function importNotesFromBackup(
    entries: NoteBackupEntry[],
    keys: BackupImportKeys
): ZkNote[] {
    // A bad KEY throws; a bad ENTRY is skipped below by failing to decrypt.
    // Without this split, a truncated viewing key returns an empty array —
    // indistinguishable from a backup that holds nobody's notes.
    assertSecretKeyBytes(keys.viewingSecretKey, 'importNotesFromBackup: viewingSecretKey');

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
        if (note) {
            out.push({
                ...note,
                spent: entry.spent ?? false,
                spentAt: entry.spentAt ?? null,
            });
        }
    }
    return out;
}

/** Structural guard for one entry: commitment + memo present, leafIndex optional. */
function isEntry(value: unknown): value is NoteBackupEntry {
    if (typeof value !== 'object' || value === null) return false;
    const e = value as Record<string, unknown>;

    // Exact shapes, not "non-empty string": a loose check admits a 4-byte
    // commitment, a truncated memo, or NaN as a tree position. Same shapes
    // `openPaymentSlip` checks for the same values.
    if (!isHexOfLength(e['commitmentHex'], 32)) return false;
    if (!isHexOfLength(e['encryptedMemo'], ENCRYPTED_MEMO_SIZE)) return false;
    if (e['leafIndex'] !== undefined && !isValidLeafIndex(e['leafIndex'] as number)) return false;

    // Spend status is copied VERBATIM into the vault, so a truthy non-boolean
    // like `spent: "no"` would mark a spendable note as spent and hide funds.
    // Optional: an older backup simply omits both.
    if (e['spent'] !== undefined && typeof e['spent'] !== 'boolean') return false;
    if (e['spentAt'] !== undefined && e['spentAt'] !== null && typeof e['spentAt'] !== 'number') {
        return false;
    }
    return true;
}
