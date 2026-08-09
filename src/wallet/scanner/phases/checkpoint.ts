/**
 * Scan checkpointing — persists completed work WHILE the scan runs, so an
 * abort or crash resumes after the last completed batch instead of restarting.
 *
 * Two writers, always invoked in this order per batch by the collect phase:
 *   1. `savePageNotes` (collect's `onPage`)      — saves the batch's NEW notes,
 *      spent status resolved from the locally synced nullifier set.
 *   2. `advanceCursor` (collect's `onBatchDone`) — moves the scan cursor past
 *      the batch.
 *
 * Notes first, cursor second: a cursor advanced past unsaved notes would make
 * the next incremental scan skip them forever.
 *
 * Existing vault notes are deliberately never written here. A save without the
 * authoritative spent map could downgrade a spent note back to unspent; the
 * persist phase remains their only writer.
 *
 * Abort safety: the signal is re-checked immediately before every write, so an
 * identity-switch abort cannot land notes decrypted under one account's keys
 * in whichever vault is open by then.
 */
import type { ZkNote } from '../../../protocol/types';
import type { VaultStore } from '../../vault/index';
import type { NoteStorage, NullifierCache, SpendDetails } from '../../vault/index';
import { stampSpentTxHash } from '../../vault/index';
import { scanAbortError } from '../../../foundation/errors/abort';
import type { NullifierSource } from '../feed/sources';
import { openSpentSet, type SpentSetHandle } from './spentSet';
import { persistCursor } from './persist';

export interface ScanCheckpointParams {
    vault: VaultStore;
    storage: NoteStorage & NullifierCache;
    nullifiers: NullifierSource;
    isIncremental: boolean;
    signal?: AbortSignal | undefined;
    onWarning?: ((message: string, cause?: unknown) => void) | undefined;
}

export interface ScanCheckpoint {
    /** Pass as `collectScanEntries`' `onPage`. */
    savePageNotes(entries: Array<{ note: ZkNote; isNew: boolean }>): Promise<void>;
    /** Pass as `collectScanEntries`' `onBatchDone`. */
    advanceCursor(maxLeafIndex: number | undefined): Promise<void>;
}

/**
 * Builds the pair of callbacks the collect phase drives. One instance per scan:
 * it lazily opens (and then reuses) the spent-set handle across batches.
 */
export function createScanCheckpoint(params: ScanCheckpointParams): ScanCheckpoint {
    const { vault, storage, nullifiers, isIncremental, signal, onWarning } = params;
    const throwIfAborted = () => {
        if (signal?.aborted) throw scanAbortError();
    };

    // Spent status comes from the locally synced nullifier set (chunks + a
    // tail snapshot), opened lazily on the first batch that finds a note —
    // most batches hold only other people's notes, and an incremental tick
    // that finds nothing must not pay a nullifier sync. On failure this
    // degrades to saving the notes unspent; the authoritative pass at the end
    // of the scan corrects them when it completes.
    let spentSetPromise: Promise<SpentSetHandle | null> | null = null;
    const getSpentSet = () =>
        (spentSetPromise ??= openSpentSet({
            source: nullifiers,
            cache: storage,
            signal,
            onWarning,
        }).catch(() => null));

    return {
        async savePageNotes(entries) {
            throwIfAborted();
            const fresh = entries.filter((e) => e.isNew);
            if (fresh.length === 0) return;

            const own = new Set(fresh.map((e) => e.note.nullifierHex.toLowerCase()));
            const spentSet = await getSpentSet();
            const spent: Map<string, SpendDetails> = spentSet
                ? await spentSet.query(own).catch(() => new Map())
                : new Map();

            // Re-checked: the awaits above (nullifier sync on the first batch)
            // are exactly where an abort can land mid-callback.
            throwIfAborted();
            await vault.saveMany(
                fresh.map(({ note }) => {
                    const spend = spent.get(note.nullifierHex.toLowerCase());
                    return {
                        note: spend ? stampSpentTxHash(note, spend.txHash) : note,
                        noteStatus: {
                            spent: spend !== undefined,
                            spentAt: spend?.spentAt ?? null,
                        },
                    };
                })
            );
        },

        async advanceCursor(maxLeafIndex) {
            if (maxLeafIndex === undefined) return;
            throwIfAborted();
            await persistCursor(storage, maxLeafIndex, isIncremental);
        },
    };
}
