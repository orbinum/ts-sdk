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
 * the cheap bookkeeping (cursor, on-chain set, counters) stays here. Both
 * transports download through the same PREFETCH-deep sliding window
 * (`runPrefetched`), overlapping network and CPU.
 */
import type { ZkNote } from '../../../protocol/types';
import { isValidLeafIndex } from '../../../protocol/spend/index';
import { stampCreatedAt, stampCreatedTxHash } from '../../vault/index';
import type { DecryptPool } from '../../worker/index';
import type { ScanKeys, SentNoteMatch, UnmatchedSentHint } from '../../worker/index';
import type { ScanHint, ScanHintPage, ScanHintSource } from '../feed/sources';
import type { ScanProgress } from '../types';
import { scanAbortError, isAbortError } from '../../../foundation/errors/abort';
import { toHex, fromHex } from '../../../foundation/encoding/hex';

/**
 * Page size for hint pagination. Round-trip overhead dominates this feed
 * (~1 s per request measured on testnet), so the tail after the sealed chunks
 * should fit in 1–2 requests rather than eight. A server that clamps this lower
 * still works — the loop reads the effective limit from the response.
 */
export const PAGE_SIZE = 2500;

/**
 * Requests kept in flight ahead of processing, in BOTH transports (chunks and
 * tail). A batch decrypts faster than the feed serves the next one, so a single
 * prefetch leaves the scan network-bound: every batch pays its round-trip in
 * series. A small window pays the RTT ~once for the whole phase instead. On a
 * bandwidth-bound connection the window changes nothing — the in-flight
 * requests share the same pipe and total time stays bytes/bandwidth — so a
 * fixed depth is safe at every connection speed. Batches are still PROCESSED
 * strictly in order; the cursor and checkpoint invariants depend on it.
 */
const PREFETCH = 3;

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
    /** Hints walked this call, across both transports. */
    scanned: number;
    /** Notes recovered that the vault did not hold yet. */
    found: number;
    /** Hints carrying no memo or ephemeral key — nothing to decrypt. */
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
    /** Notes recovered that the vault already held. */
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
    /**
     * Notes this wallet SENT, recovered in the same sweep.
     *
     * Free of extra requests: the outgoing ephPk window recognises our own
     * payments, and the change notes in the same feed carry the recipient keys
     * that open them. Kept out of `scanEntries` — the sender does not own them.
     */
    sentNotes: SentNoteMatch[];
    /**
     * Recipient viewing keys learned while opening payments, as lowercase hex.
     *
     * Accumulated across the whole scan and fed forward, so a second payment to
     * the same person opens from the first one's key.
     */
    learnedRecipients: Set<string>;
    /**
     * Payments recognised as ours that no batch managed to open.
     *
     * Their book entry sits in a change note that landed in a different page.
     * Kept so the caller can retry them once the whole feed has been read —
     * dropping one costs a history row and a re-issuable slip for good.
     */
    unmatchedSent: UnmatchedSentHint[];
    /**
     * Every sealed book entry the scan saw, as decimal `sourcePk` strings.
     *
     * A payment and its change can land in different pages, and then neither
     * half is usable alone. Accumulating both across the whole scan is what lets
     * the final retry pair them up.
     */
    sealedBookEntries: Set<string>;
    /** Highest self-eph index seen — the caller bumps the vault counter past it. */
    maxSelfEphIndex: number | null;
    /** Highest outgoing index seen — same repair, for the payment sequence. */
    maxOutgoingEphIndex: number | null;
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
    /** Sink for the one non-fatal warning this phase emits: the chunk fallback. */
    onWarning?: ((message: string, cause?: unknown) => void) | undefined;
}

/**
 * What every batch needs, threaded through the two transports. The callbacks
 * mirror {@link CollectScanEntriesParams} and are documented there.
 */
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
        // Validated, not trusted: this comes from the feed and is PERSISTED as
        // the scan cursor. `Infinity` or `NaN` there resumes every later
        // incremental scan past the end of the tree — no hint clears
        // `leafIndex >= startLeaf`, and the wallet stops finding notes in
        // silence.
        if (isValidLeafIndex(hint.leafIndex)) {
            if (outcome.maxLeafIndex === undefined || hint.leafIndex > outcome.maxLeafIndex) {
                outcome.maxLeafIndex = hint.leafIndex;
            }
        }
        outcome.scanned++;

        // The MEMO decides, never the feed's `ephPkHex` — that field is a
        // serving convenience the type declares nullable, and the kernel reads
        // the ephemeral out of the memo's last 32 bytes anyway. Gating on it
        // here would drop every such hint before the kernel saw it: a feed that
        // omits the field would make the wallet find NOTHING, cleanly.
        if (!hint.encryptedMemo) {
            outcome.noMemo++;
            continue;
        }
        toDecrypt.push(hint);
    }

    // ── Trial-decrypt the batch in the pool ───────────────────────────────────
    // Recipients learned so far ride along: a change note from an earlier page
    // is what opens the payment beside it, and the two rarely land in the same
    // batch.
    const {
        notes,
        tagFiltered,
        selfMatched,
        pairwiseMatched,
        maxSelfEphIndex,
        maxOutgoingEphIndex,
        sentNotes,
        learnedRecipients,
        unmatchedSent,
        sealedBookEntries,
    } = await ctx.pool.decryptBatch(
        toDecrypt,
        { ...ctx.keys, recipientCandidates: [...outcome.learnedRecipients].map(fromHex) },
        ctx.signal
    );
    outcome.tagFiltered += tagFiltered;
    outcome.selfDiscovered += selfMatched;
    outcome.pairwiseDiscovered += pairwiseMatched;
    // Defaulted: a host may supply its own pool, and an older one returns a
    // result without this field. Missing sent notes cost history, never the scan.
    outcome.sentNotes.push(...(sentNotes ?? []));
    outcome.unmatchedSent.push(...(unmatchedSent ?? []));
    for (const e of sealedBookEntries ?? []) outcome.sealedBookEntries.add(e);
    for (const r of learnedRecipients ?? []) outcome.learnedRecipients.add(r);
    if (maxSelfEphIndex !== null) {
        outcome.maxSelfEphIndex = Math.max(outcome.maxSelfEphIndex ?? -1, maxSelfEphIndex);
    }
    if (maxOutgoingEphIndex != null) {
        outcome.maxOutgoingEphIndex = Math.max(
            outcome.maxOutgoingEphIndex ?? -1,
            maxOutgoingEphIndex
        );
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
 * Drives `handle` over items 0..count-1 STRICTLY in order while keeping up to
 * PREFETCH downloads in flight (the one being awaited plus the ones ahead).
 * The in-order guarantee is load-bearing: the cursor and checkpoint invariants
 * assume ascending leaf order.
 *
 * Abandoned prefetches on the way out (abort/error) are silenced so they never
 * surface as unhandled rejections.
 */
async function runPrefetched<T>(
    count: number,
    fetchItem: (i: number) => Promise<T>,
    signal: AbortSignal | undefined,
    handle: (item: T) => Promise<void>
): Promise<void> {
    const inFlight = new Map<number, Promise<T>>();
    const ensureFetching = (i: number) => {
        if (i < count && !inFlight.has(i)) inFlight.set(i, fetchItem(i));
    };

    try {
        for (let i = 0; i < count; i++) {
            if (signal?.aborted) throw scanAbortError();
            for (let n = i; n < i + PREFETCH; n++) ensureFetching(n);
            const item = await inFlight.get(i)!;
            inFlight.delete(i);
            await handle(item);
        }
    } finally {
        for (const pending of inFlight.values()) pending.catch(() => {});
    }
}

/**
 * Chunk phase: downloads every sealed chunk past the cursor through the shared
 * prefetch window and processes it in order.
 *
 * Returns the leaf the tail starts at, or null when there is no chunk path
 * (source without chunk support, no manifest, no sealed chunks, or cursor
 * already past them) — the caller then pages the whole window instead.
 *
 * Any non-abort failure falls back gracefully: notes already handed to the
 * checkpoint callbacks stay persisted, and the caller resumes paging right
 * after the last processed leaf.
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

    await runPrefetched(pending.length, fetchChunk, ctx.signal, (hints) =>
        // The first chunk may straddle the cursor — drop already-scanned leaves.
        processHints(
            ctx,
            hints.filter((h) => (h.leafIndex ?? 0) >= startLeaf),
            total
        )
    );

    return manifest.lastSealedLeaf + 1;
}

/**
 * Tail phase: pages the mutable feed after the sealed chunks — or the whole
 * window when the chunk path was unavailable. The first page is fetched alone
 * because its `pagination` is what sizes the rest of the walk; the remaining
 * pages go through the shared prefetch window.
 */
async function processPaginatedTail(
    ctx: ScanContext,
    source: ScanHintSource,
    sinceLeafIndex: number | undefined
): Promise<void> {
    const fetchPage = (page: number): Promise<ScanHintPage> =>
        source.listHints({ page, limit: PAGE_SIZE, sinceLeafIndex });

    const firstPage = await fetchPage(1);
    // Progress total spans everything processed this call (chunks + tail).
    const total = ctx.outcome.scanned + firstPage.pagination.total;
    // Page math uses the limit the SERVER applied, not the one requested: a
    // server that clamps 2500 back to 500 would make dividing by the requested
    // size undercount pages and silently skip hints.
    const effectiveLimit = firstPage.pagination.limit || PAGE_SIZE;
    const totalPages = Math.max(Math.ceil(firstPage.pagination.total / effectiveLimit), 1);

    // Item i is 1-based page i+1; page 1 rides along already resolved, so the
    // window starts pulling page 2 while page 1 decrypts.
    await runPrefetched(
        totalPages,
        (i) => (i === 0 ? Promise.resolve(firstPage) : fetchPage(i + 1)),
        ctx.signal,
        (page) => processHints(ctx, page.data, total)
    );
}

/**
 * Walks the feed and trial-decrypts each memo against the wallet's keys,
 * collecting the notes it owns.
 *
 * The pool is NOT terminated here — the caller owns its lifecycle, since one
 * pool is normally reused across the scans of a session.
 */
export async function collectScanEntries(params: CollectScanEntriesParams): Promise<ScanOutcome> {
    const { source, sinceLeafIndex, signal } = params;
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
        sentNotes: [],
        unmatchedSent: [],
        sealedBookEntries: new Set<string>(),
        learnedRecipients: new Set((params.keys.recipientCandidates ?? []).map((c) => toHex(c))),
        maxSelfEphIndex: null,
        maxOutgoingEphIndex: null,
    };

    const ctx: ScanContext = {
        outcome,
        pool: params.pool,
        keys: params.keys,
        existingHexes: params.existingHexes,
        vaultHexes: params.vaultHexes ?? params.existingHexes,
        onProgress: params.onProgress,
        signal,
        onPage: params.onPage,
        onBatchDone: params.onBatchDone,
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
    await processPaginatedTail(ctx, source, tailSince);

    return outcome;
}
