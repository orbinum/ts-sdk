/**
 * Opening a vault: reading stored notes back, and deciding when what is stored
 * no longer matches the chain.
 */
import { decryptNoteRecord } from '../notes/record';
import { writeConfig } from '../storage/config';
import type { NoteStorage, VaultConfigRecord } from '../storage/contract';
import type { ZkNote } from '../../../protocol/types';

/**
 * Clears stored notes and writes a fresh config.
 *
 * Reached on first run, on a key mismatch, and on a chain fingerprint change.
 * Notes are recoverable by rescanning, so discarding them is the safe move when
 * what is stored cannot be trusted.
 */
export async function resetVaultToEmpty(
    storage: NoteStorage,
    existing: Pick<
        VaultConfigRecord,
        'createdAt' | 'selfEphCounter' | 'outgoingEphCounter' | 'pairwiseCounterparties'
    > | null,
    chainFingerprint?: string
): Promise<void> {
    if (existing) await storage.clearNotes();
    // Merged against the stored config rather than written blind: a reset must
    // still never roll an ephemeral counter backwards.
    await writeConfig(storage, existing, chainFingerprint);
}

/**
 * Whether the local vault has fallen out of step with the chain, judged by
 * validating ONE randomly chosen note.
 *
 * One is enough. The failure this detects — a chain re-genesis, pruned state —
 * invalidates every note at once, and individually missing notes are handled by
 * the ghost purge of a full scan. Checking all of them would issue one lookup
 * per note on every unlock and hand the node the wallet's entire commitment
 * set, which is exactly the linkage the scan design avoids.
 *
 * A validator that throws is treated as inconclusive rather than as a
 * mismatch: an RPC hiccup must not wipe a good vault.
 */
export async function detectCommitmentMismatch(
    notes: ZkNote[],
    validateCommitment?: (commitmentHex: string) => Promise<boolean>
): Promise<boolean> {
    if (!validateCommitment || notes.length === 0) return false;

    const sample = notes[Math.floor(Math.random() * notes.length)];
    if (!sample) return false;
    try {
        return !(await validateCommitment(sample.commitmentHex));
    } catch {
        return false;
    }
}

/**
 * Decrypts every stored record, keeping the ones that open.
 *
 * Throws only when NOTHING decrypts and there was something to decrypt, which
 * is the signature of a wrong key — the case the caller resets on.
 *
 * A single unreadable record must not take the vault with it. Records are
 * individually sealed, so one that fails is one corrupted row, not evidence
 * about the other nine hundred; failing the whole read used to discard every
 * healthy note beside it. That is recoverable by rescanning, but it turns one
 * bad byte on disk — a half-written record, a storage-quota eviction, anyone
 * with write access and no keys at all — into a full wallet wipe.
 *
 * The skipped record is reported rather than swallowed: it stays on disk, and a
 * host that never hears about it cannot tell the user why a note vanished.
 */
export async function decryptStoredNotes(
    storage: NoteStorage,
    aesKey: CryptoKey,
    onSkipped?: (skipped: number, total: number) => void
): Promise<ZkNote[]> {
    const records = await storage.getAllNoteRecords();
    const notes: ZkNote[] = [];
    let skipped = 0;

    for (const record of records) {
        try {
            notes.push(await decryptNoteRecord(aesKey, record));
        } catch {
            // Unreadable under this key: corrupt, truncated, or written by
            // another identity. Counted, never rethrown per-record.
            skipped++;
        }
    }

    // Every record failing means the key is wrong, not that the disk is. The
    // vault is reset and a rescan rebuilds it under the right key.
    if (skipped > 0 && notes.length === 0) {
        throw new Error('vault: no stored note could be decrypted with this key');
    }
    if (skipped > 0) onSkipped?.(skipped, records.length);
    return notes;
}
