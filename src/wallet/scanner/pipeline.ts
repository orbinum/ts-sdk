/**
 * Scan pipeline — the core scan, composed from independent phase modules.
 * A thin orchestrator: it wires the phases in order and owns no phase logic.
 *
 *   1. scan          — walk the hint feed, trial-decrypt memos
 *   2. spentStatus   — resolve spent status locally (see spentSet.ts)
 *   3. persist       — batched save + reconcile + ghost purge (full scan only)
 *   4. persistCursor — save the leafIndex for the next incremental scan
 *
 * Everything environment-specific is injected: the feed sources, the decrypt
 * pool, the vault. A host wires its own transport and worker strategy without
 * this file knowing either.
 */
import { fromHex } from '../../foundation/encoding/hex';
import type { VaultStore } from '../vault/index';
import type { NoteStorage, NullifierCache } from '../vault/index';
import type { DecryptPool } from '../worker/index';
import { scanAbortError } from '../../foundation/errors/abort';
import { collectScanEntries } from './phases/collect';
import { resolveSelfEphCeiling, windowSizeForCounter } from './selfEphGap';
import { collectNullifiersToQuery, resolveSpentStatus } from './phases/spentStatus';
import { persistScanResults, persistCursor } from './phases/persist';
import type { NullifierSource, ScanHintSource } from './feed/sources';
import type { ScanProgress, ScanResult } from './types';

export interface WalletScanKeys {
    viewingKey: Uint8Array;
    spendingKey: bigint;
    ownerPk: bigint;
}

export interface RunScanParams {
    vault: VaultStore;
    storage: NoteStorage & NullifierCache;
    hints: ScanHintSource;
    nullifiers: NullifierSource;
    pool: DecryptPool;
    keys: WalletScanKeys;
    /**
     * Leaf index to resume from. When set the scan is incremental; when omitted
     * it re-scans from leaf 0, which is also what enables the ghost purge.
     */
    sinceLeafIndex?: number | undefined;
    /**
     * Leaf at which the chain started emitting view tags. Hints below it carry
     * none, so the fast filter must not be applied to them. Null disables it.
     */
    viewTagActivationLeaf?: number | null | undefined;
    onProgress?: ((p: ScanProgress) => void) | undefined;
    signal?: AbortSignal | undefined;
    onWarning?: ((message: string, cause?: unknown) => void) | undefined;
}

/**
 * Runs a full or incremental scan and persists everything it finds.
 *
 * The pool is not terminated here — the caller owns its lifecycle, since one
 * pool is normally reused across the scans of a session.
 */
export async function runScan(params: RunScanParams): Promise<ScanResult> {
    const { vault, storage, hints, nullifiers, pool, keys, sinceLeafIndex, signal, onWarning } =
        params;

    const isIncremental = sinceLeafIndex !== undefined;

    // 1. Walk the feed and trial-decrypt. Nothing is persisted here: the visible
    //    note list must stay stable while a scan runs, so the user keeps working
    //    with existing notes. Results land once in phase 3, with the spent set.
    const existingHexes = new Set(vault.getAll().map((n) => n.commitmentHex));
    // Frozen copy: `existingHexes` is MUTATED by the scan as it discovers notes,
    // so it cannot double as the "what did the vault hold before we started"
    // snapshot the ghost purge needs.
    const preScanHexes = new Set(existingHexes);

    const config = await storage.getConfig().catch(() => null);
    // A wallet that already used more indexes than the default window gets a
    // proportionally larger one, so every known index stays on the fast path.
    const selfEphWindowSize = windowSizeForCounter(config?.selfEphCounter ?? 0);

    // Counterparties this wallet already knows: their payments carry an ephemeral
    // both sides derive, so the scan finds them by hash lookup instead of one
    // ECDH per hint. Unlike the self-eph window this is worth building on
    // incremental ticks too — a known sender's note can arrive at any time, and
    // the window costs the same either way.
    // A malformed entry is skipped rather than thrown: the vault is local state,
    // and one bad key must not stop the wallet from finding the rest of its notes.
    const pairwiseCounterparties = Object.keys(config?.pairwiseCounterparties ?? {}).flatMap(
        (hex) => {
            try {
                const bytes = fromHex(hex);
                return bytes.length === 32 ? [bytes] : [];
            } catch {
                return [];
            }
        }
    );

    const scan = await collectScanEntries({
        source: hints,
        pool,
        keys: {
            ...keys,
            viewTagActivationLeaf: params.viewTagActivationLeaf ?? null,
            // Self-note discovery pays a one-time window precompute per scan —
            // worth it on full scans and restores, waste on small incremental ticks.
            selfEph: !isIncremental,
            selfEphWindowSize,
            pairwiseCounterparties,
        },
        existingHexes,
        sinceLeafIndex,
        onProgress: params.onProgress,
        signal,
        // Bound the on-chain set to what the vault held before the scan: every
        // consumer probes it with a vault commitment, so keeping the whole pool
        // only bought heap.
        vaultHexes: preScanHexes,
        onWarning,
    });

    // 2. Spent status, by local intersection.
    const nullifiersToQuery = collectNullifiersToQuery(
        scan.scanEntries,
        scan.onChainHexes,
        vault.getAll()
    );
    const spentMap = await resolveSpentStatus({
        source: nullifiers,
        cache: storage,
        nullifiers: nullifiersToQuery,
        signal,
        onWarning,
    });

    // Last checkpoint before anything is written. Phases 1 and 2 only read, so
    // an abort until now costs nothing; past this line the scan mutates the
    // vault. A host that swapped identities mid-scan aborts precisely to stop
    // THIS — writing notes decrypted under one account's keys into whichever
    // vault is open by the time the scan finishes.
    if (signal?.aborted) throw scanAbortError();

    // 3. Save results + reconcile + ghost purge (full scan only).
    const purged = await persistScanResults({
        vault,
        scanEntries: scan.scanEntries,
        onChainHexes: scan.onChainHexes,
        spentMap,
        isIncremental,
        preScanHexes,
        hintsScanned: scan.scanned,
        onWarning,
    });

    // 4. Persist the scan cursor for the next incremental pass.
    await persistCursor(storage, scan.maxLeafIndex, isIncremental);

    // 4b. Sync the self-eph counter past the highest discovered index, so a new
    //     note never reuses a published ephemeral — reuse links both notes as
    //     sharing a creator. A maximum near the window top may hide higher
    //     indexes found only via trial-decrypt; the gap-limit sweep over the
    //     vault's own notes resolves the true ceiling without re-scanning.
    if (scan.maxSelfEphIndex !== null) {
        let ceiling = scan.maxSelfEphIndex;
        try {
            ceiling =
                resolveSelfEphCeiling({
                    notes: vault.getAll(),
                    spendingKey: keys.spendingKey,
                    viewingKey: keys.viewingKey,
                    scanMaxIndex: scan.maxSelfEphIndex,
                    windowSize: selfEphWindowSize,
                }) ?? ceiling;
        } catch {
            // Sweep unavailable — the plain scan maximum is still a safe lower bound.
        }
        await bumpSelfEphCounterTo(storage, ceiling + 1).catch(() => {});
    }

    // Only worth reporting when NOTHING decrypted: undecryptable hints are the
    // normal case (they belong to other wallets), but a scan that walked a
    // non-empty pool and recovered none of it usually means the wrong keys.
    if (scan.decryptFailed > 0 && scan.found === 0 && scan.alreadyPresent === 0) {
        // Aggregate only — no note identifiers in the message.
        onWarning?.(
            `no notes recovered from ${scan.decryptFailed} hint(s) with memos; ` +
                'if this wallet should hold notes, check the keys it was unlocked with'
        );
    }

    return {
        found: scan.found,
        noMemo: scan.noMemo,
        decryptFailed: scan.decryptFailed,
        alreadyPresent: scan.alreadyPresent,
        purged,
        incremental: isIncremental,
    };
}

/** Raises the counter to `next`, never lowering it — the counter is monotonic. */
async function bumpSelfEphCounterTo(storage: NoteStorage, next: number): Promise<void> {
    await storage.updateConfig((config) =>
        (config.selfEphCounter ?? 0) >= next
            ? config
            : { ...config, selfEphCounter: next, updatedAt: Date.now() }
    );
}
