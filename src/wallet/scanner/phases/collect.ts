/**
 * Phase 1 — walk the hint feed and trial-decrypt every memo against the wallet's
 * keys.
 *
 * Pure collection: this phase itself writes nothing — persistence happens only
 * through the injected `onPage`/`onBatchDone` callbacks, so the caller decides
 * what (if anything) is checkpointed while the scan runs.
 *
 * Transport, in order of preference:
 *   1. Sealed chunks — the immutable bulk of the feed, digest-addressed and
 *      cacheable. Chunks below the incremental cursor are skipped entirely.
 *   2. Paginated hints — the mutable tail after the last sealed chunk, and the
 *      full fallback when the chunk path is unavailable.
 *
 * The expensive part (one ECDH per memo) runs in the injected decrypt pool —
 * Web Workers when the host provides a factory, a yielded loop otherwise — while
 * the cheap bookkeeping (cursor, on-chain set, counters) stays here. The next
 * chunk/page is prefetched while the current one decrypts, overlapping network
 * and CPU.
 */
import type { ZkNote } from '../../../protocol/types';
import { isValidLeafIndex } from '../../../protocol/spend/index';
import { stampCreatedAt, stampCreatedTxHash } from '../../vault/index';
import type { DecryptPool } from '../../worker/index';
import type { ScanKeys } from '../../worker/index';
import type { ScanHint, ScanHintPage, ScanHintSource } from '../feed/sources';
import type { ScanProgress } from '../types';
import { scanAbortError, isAbortError } from '../../../foundation/errors/abort';

/**
 * Page size for hint pagination. Round-trip overhead dominates this feed
 * (~1 s per request measured on testnet), so the tail after the sealed chunks
 * should fit in 1–2 requests rather than eight. A server that clamps this lower
 * still works — the loop reads the effective limit from the response.
 */
export const PAGE_SIZE = 2500;

export interface ScanOutcome {
    /** Decrypted notes found in this window, flagged new vs already in the vault. */
    scanEntries: Array<{ note: ZkNote; isNew: boolean }>;
    /**
     * The wallet's OWN commitments that this window confirmed on-chain — used to
     * reconcile memo-failed vault notes (always) and to purge ghosts (full scan
     * only; an incremental window must not purge notes from earlier blocks).
     *
     * Deliberately NOT every commitment in the window. Every consumer probes
     * this with a vault commitment and never iterates it, so keeping the whole
     * pool bought nothing and cost everything: a 1M scan held 1M hex strings and
     * peaked at 895 MB RSS, which extrapolates to ~9 GB at 10M — the heap gives
     * out long before the CPU does.
     *
     * Filtering as hints arrive makes this O(wallet notes) instead of O(pool).
     * The ghost purge reads it inverted (absence means "gone from chain"), so
     * accumulation must stay unconditional across the whole scanned window — an
     * early exit here would delete live notes.
     */
    onChainHexes: Set<string>;
    /** Highest leafIndex seen — the next incremental scan resumes after it. */
    maxLeafIndex: number | undefined;
    scanned: number;
    found: number;
    noMemo: number;
    /**
     * Hints whose memo did not open with this wallet's keys.
     *
     * Mostly NOT a failure: every note belonging to someone else lands here, so
     * on a healthy scan this is close to the pool size minus the view-tag
     * filter's share. It is worth reporting only as a ratio — a wallet that
     * recovers nothing while this equals the whole pool has a key problem.
     */
    decryptFailed: number;
    alreadyPresent: number;
    /** Hints discarded by the view-tag fast filter (no AEAD decrypt attempted). */
    tagFiltered: number;
    /** Own notes recognized via the deterministic self-eph window (no trial ECDH). */
    selfDiscovered: number;
    /**
     * Notes from known counterparties recognized via their pairwise window (no
     * trial ECDH). Separate from `selfDiscovered` so a run can prove the pairwise
     * path fired rather than the notes quietly taking the expensive route.
     */
    pairwiseDiscovered: number;
    /** Highest self-eph index seen — the caller bumps the vault counter past it. */
    maxSelfEphIndex: number | null;
}

export interface CollectScanEntriesParams {
    source: ScanHintSource;
    pool: DecryptPool;
    keys: ScanKeys;
    /**
     * Commitments the vault already holds. MUTATED as the scan discovers notes,
     * so callers that also need a pre-scan snapshot must pass a frozen copy as
     * `vaultHexes`.
     */
    existingHexes: Set<string>;
    /** Incremental mode: only leaves at or above this index are fetched. */
    sinceLeafIndex?: number | undefined;
    onProgress?: ((p: ScanProgress) => void) | undefined;
    signal?: AbortSignal | undefined;
    /**
     * Awaited after each chunk/page with only that batch's entries, so callers
     * can persist notes as they are discovered rather than at the end.
     */
    onPage?: ((entries: Array<{ note: ZkNote; isNew: boolean }>) => Promise<void>) | undefined;
    /**
     * Awaited after each fully processed chunk/page — AFTER `onPage`, so the
     * batch's notes are already in the caller's hands — with the highest valid
     * leaf seen so far. Fires for every batch, including ones with no owned
     * notes: that is the common case, and the checkpoint must advance past
     * other people's leaves too. Lets callers persist the scan cursor
     * incrementally so an aborted scan resumes instead of restarting.
     */
    onBatchDone?: ((maxLeafIndex: number | undefined) => Promise<void>) | undefined;
    /**
     * Bounds `outcome.onChainHexes` to commitments the wallet actually holds.
     * Pass the pre-scan snapshot, since `existingHexes` grows during the scan.
     * Defaults to `existingHexes`, which is correct but lets mid-scan
     * discoveries into the set; harmless, since the ghost purge filters them.
     */
    vaultHexes?: Set<string> | undefined;
    /** Sink for the two non-fatal warnings this phase can emit. */
    onWarning?: ((message: string, cause?: unknown) => void) | undefined;
}

interface ScanContext {
    outcome: ScanOutcome;
    pool: DecryptPool;
    keys: ScanKeys;
    existingHexes: Set<string>;
    vaultHexes: Set<string>;
    onProgress?: ((p: ScanProgress) => void) | undefined;
    signal?: AbortSignal | undefined;
    onPage?: ((entries: Array<{ note: ZkNote; isNew: boolean }>) => Promise<void>) | undefined;
    onBatchDone?: ((maxLeafIndex: number | undefined) => Promise<void>) | undefined;
}

/**
 * Processes one batch of hints (a page or a chunk): cheap bookkeeping on the
 * calling thread, trial-decryption in the pool, then hands the recovered notes
 * to `onPage` and reports progress against `total`.
 */
async function processHints(ctx: ScanContext, hints: ScanHint[], total: number) {
    const { outcome } = ctx;

    // ── Cheap bookkeeping — commitments, cursor, memo filter ──────────────────
    const toDecrypt: ScanHint[] = [];
    for (const hint of hints) {
        // Only the wallet's own commitments are worth keeping — see ScanOutcome.
        if (ctx.vaultHexes.has(hint.commitmentHex)) outcome.onChainHexes.add(hint.commitmentHex);
        // Validated, not trusted: this value comes from the feed and is PERSISTED
        // as the scan cursor. `Infinity` or `NaN` there makes every later
        // incremental scan resume past the end of the tree — no hint ever clears
        // `leafIndex >= startLeaf`, so the wallet silently stops finding notes
        // and nothing reports an error.
        if (isValidLeafIndex(hint.leafIndex)) {
            if (outcome.maxLeafIndex === undefined || hint.leafIndex > outcome.maxLeafIndex) {
                outcome.maxLeafIndex = hint.leafIndex;
            }
        }
        outcome.scanned++;

        if (!hint.encryptedMemo || !hint.ephPkHex) {
            outcome.noMemo++;
            continue;
        }
        toDecrypt.push(hint);
    }

    // ── Trial-decrypt the batch in the pool ───────────────────────────────────
    const { notes, tagFiltered, selfMatched, pairwiseMatched, maxSelfEphIndex } =
        await ctx.pool.decryptBatch(toDecrypt, ctx.keys, ctx.signal);
    outcome.tagFiltered += tagFiltered;
    outcome.selfDiscovered += selfMatched;
    outcome.pairwiseDiscovered += pairwiseMatched;
    if (maxSelfEphIndex !== null) {
        outcome.maxSelfEphIndex = Math.max(outcome.maxSelfEphIndex ?? -1, maxSelfEphIndex);
    }

    // ── Tag new vs already-present and accumulate ─────────────────────────────
    const pageEntries: Array<{ note: ZkNote; isNew: boolean }> = [];
    for (const [i, decrypted] of notes.entries()) {
        // Both stamps come from the same hint: the block time and the hash of the
        // extrinsic that created the commitment. Either may be absent, and the
        // stamp helpers leave the note untouched in that case.
        const hint = toDecrypt[i]!;
        const note =
            decrypted &&
            stampCreatedTxHash(stampCreatedAt(decrypted, hint.timestampMs ?? null), hint.txHash);
        if (!note) {
            // Expected for every note owned by someone else. No per-item
            // logging either way: printing a commitment hex or leafIndex would
            // leak note identifiers to the console (extensions, shared screens,
            // bug reports).
            outcome.decryptFailed++;
            continue;
        }
        // Zero-value notes are the change output of an exact-amount transfer.
        // They are unspendable (the transfer circuit treats a value-0 input as a
        // dummy and forces its nullifier to 0), so never store them — they would
        // only confuse the balance and break a proof if hand-picked.
        if (note.value === 0n) continue;
        const isNew = !ctx.existingHexes.has(note.commitmentHex);
        if (isNew) {
            ctx.existingHexes.add(note.commitmentHex);
            outcome.found++;
        } else {
            outcome.alreadyPresent++;
        }
        outcome.scanEntries.push({ note, isNew });
        pageEntries.push({ note, isNew });
    }

    // Hand this batch's notes over before reporting progress, so the count the
    // caller shows is backed by notes it can already render.
    if (pageEntries.length > 0) await ctx.onPage?.(pageEntries);
    // Notes first, cursor second: a checkpoint that advanced past unsaved
    // notes would make the next incremental scan skip them forever.
    await ctx.onBatchDone?.(outcome.maxLeafIndex);
    ctx.onProgress?.({ scanned: outcome.scanned, total, found: outcome.found });
}

/**
 * Chunk phase: downloads every sealed chunk past the cursor and processes it,
 * prefetching the next while the current one decrypts. Returns the leaf the tail
 * starts at, or null when there is no chunk path (source without chunk support,
 * no manifest, no sealed chunks, or cursor already past them) — the caller then
 * pages the whole window instead.
 *
 * Any non-abort failure falls back gracefully: notes already processed are
 * persisted (via onPage) and the caller resumes paging right after the last
 * processed leaf.
 */
async function processSealedChunks(
    ctx: ScanContext,
    source: ScanHintSource,
    sinceLeafIndex: number | undefined
): Promise<number | null> {
    if (!source.chunks) return null;
    const manifest = await source.chunks.manifest().catch(() => null);
    if (!manifest || manifest.chunks.length === 0) return null;

    const startLeaf = sinceLeafIndex ?? 0;
    if (startLeaf > manifest.lastSealedLeaf) return null; // everything sealed is already scanned

    // Chunk i covers leaves [i·chunkSize, (i+1)·chunkSize) — skip fully-scanned ones.
    const pending = manifest.chunks.filter(
        (ch) => ch.idx >= Math.floor(startLeaf / manifest.chunkSize)
    );
    if (pending.length === 0) return null;

    // Leaves are dense, so the remaining work (sealed + tail) is total - startLeaf.
    const total = Math.max(manifest.total - startLeaf, 0);

    const fetchChunk = (i: number) => source.chunks!.chunk(pending[i]!.idx, pending[i]!.digest);

    let nextChunk: Promise<ScanHint[]> | null = fetchChunk(0);
    try {
        for (let i = 0; i < pending.length; i++) {
            if (ctx.signal?.aborted) throw scanAbortError();
            const hints = await nextChunk!;
            nextChunk = i + 1 < pending.length ? fetchChunk(i + 1) : null;
            // The first chunk may straddle the cursor — drop already-scanned leaves.
            await processHints(
                ctx,
                hints.filter((h) => (h.leafIndex ?? 0) >= startLeaf),
                total
            );
        }
    } finally {
        // An abandoned prefetch (abort/error path) must not surface as an
        // unhandled rejection.
        nextChunk?.catch(() => {});
    }

    return manifest.lastSealedLeaf + 1;
}

/**
 * Walks the feed and trial-decrypts each memo against the wallet's keys,
 * collecting the notes it owns.
 *
 * The pool is NOT terminated here — the caller owns its lifecycle, since one
 * pool is normally reused across the scans of a session.
 */
export async function collectScanEntries(params: CollectScanEntriesParams): Promise<ScanOutcome> {
    const { source, pool, keys, existingHexes, sinceLeafIndex, onProgress, signal, onPage } =
        params;
    const { onBatchDone } = params;
    if (signal?.aborted) throw scanAbortError();

    const outcome: ScanOutcome = {
        scanEntries: [],
        onChainHexes: new Set<string>(),
        maxLeafIndex: undefined,
        scanned: 0,
        found: 0,
        noMemo: 0,
        decryptFailed: 0,
        alreadyPresent: 0,
        tagFiltered: 0,
        selfDiscovered: 0,
        pairwiseDiscovered: 0,
        maxSelfEphIndex: null,
    };

    const ctx: ScanContext = {
        outcome,
        pool,
        keys,
        existingHexes,
        vaultHexes: params.vaultHexes ?? existingHexes,
        onProgress,
        signal,
        onPage,
        onBatchDone,
    };

    // ── Phase A: sealed chunks (immutable bulk, cache-friendly) ───────────────
    let tailSince = sinceLeafIndex;
    try {
        const tailStart = await processSealedChunks(ctx, source, sinceLeafIndex);
        if (tailStart !== null) tailSince = tailStart;
    } catch (err) {
        if (isAbortError(err)) throw err;
        // Chunk path broke mid-way (reseal race, flaky edge). Everything already
        // processed is persisted; resume paging right after the last seen leaf.
        params.onWarning?.('sealed-chunk path failed; falling back to paginated hints', err);
        if (outcome.maxLeafIndex !== undefined) tailSince = outcome.maxLeafIndex + 1;
    }

    // ── Phase B: paginated hints (tail, or the whole window on fallback) ──────
    const fetchPage = (page: number): Promise<ScanHintPage> =>
        source.listHints({ page, limit: PAGE_SIZE, sinceLeafIndex: tailSince });

    const firstPage = await fetchPage(1);
    // Progress total spans everything processed this call (chunks + tail).
    const total = outcome.scanned + firstPage.pagination.total;
    // Page math uses the limit the SERVER applied, not the one requested: a
    // server that clamps 2500 back to 500 would make dividing by the requested
    // size undercount pages and silently skip hints.
    const effectiveLimit = firstPage.pagination.limit || PAGE_SIZE;
    const totalPages = Math.ceil(firstPage.pagination.total / effectiveLimit);

    // A page decrypts faster than the feed serves the next one, so a single-page
    // prefetch leaves the scan network-bound. Keep a small sliding window of
    // requests in flight; pages are still PROCESSED in order, so the leafIndex
    // cursor invariants hold.
    const PREFETCH = 3;
    const inFlight = new Map<number, Promise<ScanHintPage>>();
    const ensureFetching = (page: number) => {
        if (page >= 2 && page <= totalPages && !inFlight.has(page)) {
            inFlight.set(page, fetchPage(page));
        }
    };

    try {
        for (let p = 2; p < 2 + PREFETCH; p++) ensureFetching(p);
        await processHints(ctx, firstPage.data, total);
        for (let page = 2; page <= totalPages; page++) {
            if (signal?.aborted) throw scanAbortError();
            ensureFetching(page);
            const current = await inFlight.get(page)!;
            inFlight.delete(page);
            for (let p = page + 1; p <= page + PREFETCH; p++) ensureFetching(p);
            await processHints(ctx, current.data, total);
        }
    } finally {
        // Abandoned prefetches (abort/error) must not surface as unhandled rejections.
        for (const pending of inFlight.values()) pending.catch(() => {});
    }

    return outcome;
}
