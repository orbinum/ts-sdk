/**
 * Scan pipeline — the core scan, composed from independent phase modules.
 * A thin orchestrator: it wires the phases in order and owns no phase logic.
 *
 *   1. collect       — walk the hint feed, trial-decrypt memos; each completed
 *                      batch is checkpointed (checkpoint.ts): new notes saved,
 *                      cursor advanced, so an abort or crash resumes there
 *   2. spentStatus   — resolve spent status locally (see spentSet.ts)
 *   3. persist       — batched save + reconcile + ghost purge (full scan only)
 *   4. persistCursor — save the final leafIndex for the next incremental scan
 *
 * Everything environment-specific is injected: the feed sources, the decrypt
 * pool, the vault. A host wires its own transport and worker strategy without
 * this file knowing either.
 */
import { fromHex, toHex } from '../../foundation/encoding/hex';
import { recoverSentNote, openRecipientBookEntry } from '../../protocol/note/index';
import type { VaultStore } from '../vault/index';
import type { NoteStorage, NullifierCache } from '../vault/index';
import type { DecryptPool } from '../worker/index';
import { scanAbortError } from '../../foundation/errors/abort';
import { collectScanEntries } from './phases/collect';
import { createScanCheckpoint } from './phases/checkpoint';
import { resolveSelfEphCeiling, windowSizeForCounter } from './selfEphGap';
import { collectNullifiersToQuery, resolveSpentStatus } from './phases/spentStatus';
import { persistScanResults, persistCursor } from './phases/persist';
import type { NullifierSource, ScanHintSource } from './feed/sources';
import type { ScanProgress, ScanResult } from './types';

/**
 * Indexes skipped when the outgoing counter is rebuilt from a scan.
 *
 * The scan only sees what the feed served. One that withholds the highest
 * outputs would leave the counter short, and the next payment would republish a
 * published ephemeral. Resuming past a gap means withholding one output is not
 * enough — a whole run would have to vanish. Skipped indexes cost nothing.
 */
const OUTGOING_RESCAN_GAP = 8;

/**
 * Ceiling on each side of the cross-batch sent-note retry.
 *
 * The retry is quadratic — one ECDH per (payment, book entry) pair — and runs
 * synchronously on the caller's thread. 64×64 is ~4k operations, well under a
 * second; the unbounded version measured ~6s at 200×200 and grows from there,
 * on data a feed controls.
 *
 * It only bounds the RETRY. Payments whose change note shared their batch were
 * already opened, and this path exists solely for the ones a page boundary
 * split — a rare case where the two halves are near neighbours anyway.
 */
const RETRY_BOOK_LIMIT = 64;

export interface WalletScanKeys {
    viewingKey: Uint8Array;
    spendingKey: bigint;
    ownerPk: bigint;
    /**
     * Outgoing viewing key (ovk). Omit to scan WITHOUT payment history: every
     * note the wallet owns is still found, and the sender-side record of what
     * it paid simply is not reconstructed. That is the watch-only case.
     */
    outgoingViewingKey?: Uint8Array;
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

    // 1. Walk the feed and trial-decrypt. NEW notes and the cursor are
    //    checkpointed per batch (checkpoint.ts), so an abort or crash never
    //    loses completed work; existing notes are only rewritten in phase 3,
    //    with the authoritative spent set.
    const existingHexes = new Set(vault.getAll().map((n) => n.commitmentHex));
    // Frozen copy: `existingHexes` is MUTATED by the scan as it discovers notes,
    // so it cannot double as the "what did the vault hold before we started"
    // snapshot the ghost purge needs.
    const preScanHexes = new Set(existingHexes);

    const config = await storage.getConfig().catch(() => null);
    // A wallet that already used more indexes than the default window gets a
    // proportionally larger one, so every known index stays on the fast path.
    const selfEphWindowSize = windowSizeForCounter(config?.selfEphCounter ?? 0);
    // Same rule for the outgoing sequence: a wallet that has sent more payments
    // than the default window would leave its oldest ones unrecoverable, and a
    // high index that the window cannot see is also one the counter
    // reconstruction would hand out again.
    const outgoingEphWindowSize = windowSizeForCounter(config?.outgoingEphCounter ?? 0);

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

    // Persists completed batches (new notes + cursor) while phase 1 runs, so
    // an abort or crash resumes after the last completed batch — the what and
    // why live in checkpoint.ts.
    const checkpoint = createScanCheckpoint({
        vault,
        storage,
        nullifiers,
        isIncremental,
        signal,
        onWarning,
    });

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
            // Sent-note discovery rides the same full-scan/restore budget as
            // self discovery: on an incremental tick the history is already
            // there, and the window would be paid for nothing.
            outgoingEph: !isIncremental,
            outgoingEphWindowSize,
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
        onPage: (entries) => checkpoint.savePageNotes(entries),
        onBatchDone: (maxLeafIndex) => checkpoint.advanceCursor(maxLeafIndex),
    });

    // 1b. Payments no batch could open, retried against the whole scan's book.
    //
    // A page boundary between a payment and its change is enough to strand one:
    // the batch that held the payment had not seen the change note yet, and the
    // batch that holds the change is past it. Retrying here is the first moment
    // every recipient key the scan will ever learn is in one place. Pure local
    // arithmetic — no request, and only over payments already recognised as
    // ours.
    const ovk = keys.outgoingViewingKey;
    if (scan.unmatchedSent.length > 0 && ovk) {
        // Both halves of the book: keys already proven by an opened payment, and
        // entries still sealed, which only open against the commitment of the
        // payment they name — so they are resolved per hint, below.
        const proven = [...scan.learnedRecipients].map(fromHex);
        // BOUNDED, because this loop is quadratic — one ECDH per (payment,
        // entry) pair — and runs synchronously outside the decrypt pool, on the
        // host's main thread. Neither side is self-limiting: both accumulate
        // across the whole scan from data a feed chose to serve.
        //
        // The newest entries are kept because a stranded payment is stranded by
        // a PAGE BOUNDARY, so its change note is a near neighbour, not an
        // ancient one. Anything dropped here is not lost for good — the next
        // full scan sees both halves in one batch and opens it there.
        const keptEntries = [...scan.sealedBookEntries].slice(-RETRY_BOOK_LIMIT);
        // Parsed one by one rather than with a bare `.map(BigInt)`: these are
        // strings that crossed a worker boundary, and `BigInt('')` throws. One
        // malformed entry would take down the whole retry pass — every stranded
        // payment in the scan, not just the one it belongs to.
        const sealed: bigint[] = [];
        for (const entry of keptEntries) {
            try {
                sealed.push(BigInt(entry));
            } catch {
                // Not a number: it cannot be a book entry, so it opens nothing.
            }
        }
        const retries = scan.unmatchedSent.slice(-RETRY_BOOK_LIMIT);
        if (retries.length < scan.unmatchedSent.length) {
            onWarning?.(
                `sent-note retry capped at ${retries.length} of ${scan.unmatchedSent.length}; ` +
                    'the rest resolve on the next full scan'
            );
        }
        // The book is capped too, and dropping entries silently is what makes a
        // half-recovered history look complete.
        if (keptEntries.length < scan.sealedBookEntries.size) {
            onWarning?.(
                `recipient book capped at ${keptEntries.length} of ${scan.sealedBookEntries.size} ` +
                    'entries; older payments resolve on the next full scan'
            );
        }
        for (const { hint, ephIndex } of retries) {
            // The user can cancel; this loop is long enough to need asking.
            if (signal?.aborted) throw scanAbortError();
            const candidates = [
                ...sealed.map((e) => openRecipientBookEntry(e, ovk, hint.commitmentHex)),
                ...proven,
            ];
            const sent = recoverSentNote({
                hint,
                outgoingViewingKey: ovk,
                ephIndex,
                recipientCandidates: candidates,
            });
            if (!sent) continue;
            const { recipientIvk, ...facts } = sent;
            scan.sentNotes.push({
                ...facts,
                counterpartyIvkHex: toHex(recipientIvk),
                encryptedMemo: hint.encryptedMemo ?? '',
            });
        }
    }

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

    // Last signal check before the FINAL writes. Phase 1's checkpoint writes
    // are individually signal-guarded (checkpoint.ts); past this line the scan
    // rewrites EXISTING notes and purges ghosts. A host that swapped identities
    // mid-scan aborts precisely to stop this — writing notes decrypted under
    // one account's keys into whichever vault is open by the time the scan
    // finishes.
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
                    viewingKey: keys.viewingKey,
                    scanMaxIndex: scan.maxSelfEphIndex,
                    windowSize: selfEphWindowSize,
                }) ?? ceiling;
        } catch {
            // Sweep unavailable — the plain scan maximum is still a safe lower bound.
        }
        await bumpSelfEphCounterTo(storage, ceiling + 1).catch(() => {});
    }

    // 4c. The same repair for the OUTGOING sequence, and the one that closes the
    //     restore hole: a wallet rebuilt from its seed has no counter, so without
    //     this its next payment would start at 0 and republish the ephemeral of
    //     its own first payment — linking the two in public.
    //
    //     Every index counted here was matched against this wallet's own window,
    //     so it is one this wallet demonstrably published. The gap is deliberate,
    //     for the same reason `reserveOutgoingIndex` leaves one: a feed that hides
    //     the highest outputs would otherwise walk the counter back onto them.
    if (scan.maxOutgoingEphIndex !== null) {
        await bumpOutgoingCounterTo(
            storage,
            scan.maxOutgoingEphIndex + 1 + OUTGOING_RESCAN_GAP
        ).catch(() => {});
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
        sentNotes: scan.sentNotes,
        discovery: {
            self: scan.selfDiscovered,
            pairwise: scan.pairwiseDiscovered,
            tagFiltered: scan.tagFiltered,
        },
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

/** Same, for the outgoing sequence. Monotonic for the same reason. */
async function bumpOutgoingCounterTo(storage: NoteStorage, next: number): Promise<void> {
    await storage.updateConfig((config) =>
        (config.outgoingEphCounter ?? 0) >= next
            ? config
            : { ...config, outgoingEphCounter: next, updatedAt: Date.now() }
    );
}
