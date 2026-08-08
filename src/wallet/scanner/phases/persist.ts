/**
 * Scan phases 3–4 — persist the scan outcome:
 *   3. Save the scanned notes with their spent status + reconcile memo-failed
 *      vault notes, in ONE batched write, then purge ghost notes (full scan).
 *   4. Persist the scan cursor for the next incremental pass.
 */
import type { ZkNote } from '../../../protocol/types';
import type { NoteStorage, SpendDetails } from '../../vault/index';
import type { VaultStore } from '../../vault/index';
import { stampSpentTxHash } from '../../vault/index';

interface SaveEntry {
    note: ZkNote;
    noteStatus?: { spent: boolean; spentAt: number | null };
    forceUpdate?: boolean;
}

export interface PersistParams {
    vault: VaultStore;
    scanEntries: Array<{ note: ZkNote; isNew: boolean }>;
    onChainHexes: Set<string>;
    /** Spent members of this pass's nullifiers → spend details (block time + tx hash). */
    spentMap: Map<string, SpendDetails>;
    isIncremental: boolean;
    /**
     * Commitments the vault held when the scan STARTED. Only these are
     * purgeable — see {@link selectGhosts}. Omitted means "every current note is
     * fair game", which is only safe when no note can be created mid-scan.
     */
    preScanHexes?: Set<string> | undefined;
    /**
     * Hints this scan walked. Feeds the purge safety gate — zero means the feed
     * answered with nothing, which is not evidence of a rollback.
     */
    hintsScanned: number;
    /** Reports a purge the safety gate refused. See {@link purgeIsTrustworthy}. */
    onWarning?: ((message: string) => void) | undefined;
}

/**
 * Whether this scan saw enough of the feed for its silence to mean anything.
 *
 * The purge reads absence as evidence: a vault commitment missing from
 * `onChainHexes` is treated as rolled back. That inference only holds if the
 * feed actually answered. An indexer that was reset, pointed at the wrong
 * network, or that returns an empty page with HTTP 200 serves ZERO hints — and
 * the purge then reads that as "every note you own is gone" and empties the
 * vault. A scan that walked nothing has proven nothing.
 *
 * The signal is hints WALKED, not vault notes confirmed. Confirming none of the
 * wallet's own commitments is perfectly normal — it is what a rollback looks
 * like, and it is also what a wallet whose notes all moved looks like. Only an
 * empty walk is unambiguous evidence that the feed, not the chain, is the
 * problem.
 *
 * This deliberately does NOT try to detect partial censorship. A feed that omits
 * one commitment while serving the rest still deletes exactly that note, and no
 * local heuristic separates that from a genuine rollback — the feed is trusted
 * for note existence by construction. Closing that needs a second source or an
 * on-chain root check, which is a protocol change rather than a guard.
 */
export function purgeIsTrustworthy(hintsScanned: number, purgeableNotes: number): boolean {
    if (purgeableNotes === 0) return true;
    return hintsScanned > 0;
}

/**
 * The notes to purge as ghosts: unspent, absent from the on-chain set, and
 * already in the vault when the scan began.
 *
 * That last condition is what protects a note the user just created.
 * `onChainHexes` is a snapshot frozen as the scan paged the feed, so a
 * shield/transfer that lands mid-scan is legitimately missing from it — the feed
 * had not served it yet, or its leaf sat behind the paging cursor. Purging on
 * absence alone deleted that note from memory AND storage seconds after the user
 * saw it, and only a later rescan brought it back.
 *
 * A note born mid-scan is simply not this scan's business; the next pass, run
 * against a feed that has caught up, reconciles it.
 */
export function selectGhosts(
    notes: ZkNote[],
    onChainHexes: Set<string>,
    preScanHexes?: Set<string>
): string[] {
    return notes
        .filter((note) => !note.spent && !onChainHexes.has(note.commitmentHex))
        .filter((note) => preScanHexes === undefined || preScanHexes.has(note.commitmentHex))
        .map((note) => note.commitmentHex);
}

/**
 * Phase 3: builds the batched save-entry list, writes it in one transaction,
 * then purges ghost notes (full scan only). Returns the number of ghosts purged.
 *
 * Both the scanned notes and the memo-failed reconciliation feed a SINGLE
 * saveMany → one storage transaction and one cache write, so subscribers
 * re-render once per call instead of once per note.
 */
export async function persistScanResults(params: PersistParams): Promise<number> {
    const { vault, scanEntries, onChainHexes, spentMap, isIncremental, preScanHexes } = params;
    const syncedCommitments = new Set(scanEntries.map((e) => e.note.commitmentHex));
    const saveEntries: SaveEntry[] = [];

    // spentAt is the spend's BLOCK time from the nullifier set. A null timestamp
    // stays null, and applyNoteStatus then keeps whatever spentAt the note
    // already has (e.g. the local stamp from our own spend). Chain time is stable
    // across passes, so rescans never rewrite it.
    //
    // The spending tx hash rides on the NOTE, not on noteStatus: NoteStatusUpdate
    // only carries spent/spentAt, while the note object is serialized whole.
    // stampSpentTxHash keeps an existing hash, so a rescan never clobbers the one
    // recorded when we spent the note ourselves.
    for (const { note, isNew } of scanEntries) {
        const hex = note.nullifierHex.toLowerCase();
        const spend = spentMap.get(hex);
        const isSpentOnChain = spend !== undefined;
        // A full rescan overwrites all cryptographic fields (spendingKey,
        // nullifier, ownerPk) in case they were stored incorrectly by an older
        // version. Incremental scans skip this to avoid redundant re-encryption;
        // new notes always write.
        saveEntries.push({
            note: isSpentOnChain ? stampSpentTxHash(note, spend.txHash) : note,
            noteStatus: {
                spent: isSpentOnChain,
                spentAt: isSpentOnChain ? spend.spentAt : null,
            },
            forceUpdate: !isNew && !isIncremental,
        });
    }

    // Reconcile memo-failed vault notes that turned spent on-chain this window.
    for (const vaultNote of vault.getAll()) {
        if (syncedCommitments.has(vaultNote.commitmentHex)) continue;
        if (!onChainHexes.has(vaultNote.commitmentHex)) continue;
        const hex = vaultNote.nullifierHex?.toLowerCase() ?? '';
        const spend = spentMap.get(hex);
        if (!vaultNote.spent && spend) {
            saveEntries.push({
                note: stampSpentTxHash(vaultNote, spend.txHash),
                noteStatus: { spent: true, spentAt: spend.spentAt },
            });
        }
    }

    await vault.saveMany(saveEntries);

    // Purge ghosts (full scan only — an incremental window would incorrectly
    // remove notes from earlier blocks it never fetched).
    if (isIncremental) return 0;
    const ghosts = selectGhosts(vault.getAll(), onChainHexes, preScanHexes);

    // A feed that confirmed nothing has proven nothing. Deleting on its silence
    // turns an unreachable indexer into a wiped wallet.
    if (!purgeIsTrustworthy(params.hintsScanned, ghosts.length)) {
        params.onWarning?.(
            `skipped purging ${ghosts.length} note(s): the feed served no hints this scan, ` +
                'so its silence is not evidence they were rolled back'
        );
        return 0;
    }
    return vault.removeMany(ghosts);
}

/**
 * Phase 4: persist the scan cursor. Advances to `maxLeafIndex` when this pass
 * saw commitments; a full scan that saw none resets the cursor.
 */
export async function persistCursor(
    storage: NoteStorage,
    maxLeafIndex: number | undefined,
    isIncremental: boolean
): Promise<void> {
    if (maxLeafIndex === undefined && isIncremental) return;
    await storage.updateConfig((config) => {
        // A reset DELETES the key rather than storing undefined: a stored
        // `lastScannedLeafIndex: undefined` would round-trip through structured
        // clone as a present key, and the next scan would read it as a cursor.
        const next = { ...config, updatedAt: Date.now() };
        if (maxLeafIndex === undefined) delete next.lastScannedLeafIndex;
        else next.lastScannedLeafIndex = maxLeafIndex;
        return next;
    });
}
