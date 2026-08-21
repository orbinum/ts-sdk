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
 * Whether this scan saw enough of the feed for its SILENCE to mean anything.
 *
 * The purge reads absence as evidence, which only holds if the feed answered at
 * all. An indexer that was reset, pointed at the wrong network, or that returns
 * an empty page with HTTP 200 serves zero hints — and the purge would read that
 * as "every note you own is gone".
 *
 * The signal is hints WALKED, not vault notes confirmed: confirming none of the
 * wallet's own commitments is normal, and looks identical whether the notes
 * rolled back or simply all moved. Only an empty walk is unambiguous.
 *
 * Deliberately does NOT detect partial censorship — a feed omitting one
 * commitment while serving the rest deletes exactly that note, and no local
 * heuristic separates that from a real rollback. Closing it needs a second
 * source or an on-chain root check, which is a protocol change, not a guard.
 */
export function purgeIsTrustworthy(hintsScanned: number, purgeableNotes: number): boolean {
    if (purgeableNotes === 0) return true;
    return hintsScanned > 0;
}

/**
 * The notes to purge as ghosts: unspent, absent from the on-chain set, and
 * already in the vault when the scan BEGAN.
 *
 * That last condition protects a note the user just created. `onChainHexes` is
 * frozen as the scan pages the feed, so a shield or transfer landing mid-scan is
 * legitimately missing from it — purging on absence alone deleted such a note
 * from memory and storage seconds after the user saw it.
 *
 * A note born mid-scan is not this scan's business; the next pass reconciles it.
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
 * Phase 3: build the batched save-entry list, write it in one transaction, then
 * purge ghost notes (full scan only). Returns how many ghosts were purged.
 */
export async function persistScanResults(params: PersistParams): Promise<number> {
    const { vault, scanEntries, onChainHexes, spentMap, isIncremental, preScanHexes } = params;
    const syncedCommitments = new Set(scanEntries.map((e) => e.note.commitmentHex));
    const saveEntries: SaveEntry[] = [];

    // ── 1. The notes this scan decrypted ──────────────────────────────────────
    // `spentAt` is the spend's BLOCK time, stable across passes, so a rescan
    // never rewrites it — and a null one leaves whatever the note already had,
    // such as the local stamp from our own spend.
    //
    // The spending tx hash rides on the NOTE, not on `noteStatus`, which only
    // carries spent/spentAt. `stampSpentTxHash` keeps an existing hash, so a
    // rescan never clobbers the one recorded when we spent it ourselves.
    for (const { note, isNew } of scanEntries) {
        const hex = note.nullifierHex.toLowerCase();
        const spend = spentMap.get(hex);
        const isSpentOnChain = spend !== undefined;
        // A full rescan overwrites the cryptographic fields, in case an older
        // version stored them wrong. Incremental skips it to avoid redundant
        // re-encryption; new notes always write.
        saveEntries.push({
            note: isSpentOnChain ? stampSpentTxHash(note, spend.txHash) : note,
            noteStatus: {
                spent: isSpentOnChain,
                spentAt: isSpentOnChain ? spend.spentAt : null,
            },
            forceUpdate: !isNew && !isIncremental,
        });
    }

    // ── 2. Vault notes whose memo never opened, but that went spent on chain ──
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

    // One batched write for both lists: a single storage transaction and a
    // single cache write, so subscribers re-render once instead of once a note.
    await vault.saveMany(saveEntries);

    // ── 3. Purge ghosts — full scan only ──────────────────────────────────────
    // An incremental window never fetched the earlier blocks, so absence there
    // proves nothing.
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
