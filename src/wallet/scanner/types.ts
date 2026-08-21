/**
 * What a scan reports: progress while it runs, and its outcome when it ends.
 *
 * A host renders both, so these are the scanner's public vocabulary. The
 * counters are DIAGNOSTICS, not results — the notes themselves land in the
 * vault, and every field here exists so a host can tell a scan that found
 * nothing from a scan that failed to look.
 *
 * That distinction is the reason the discovery counters are surfaced at all:
 * the fast paths fail silently by design (a window that never matches costs
 * only speed), so without them "the fast path is off" and "the fast path ran
 * and matched nothing" are indistinguishable.
 */
import type { SentNoteMatch } from '../worker/index';
/** Live progress, reported after each scanned page or chunk. */
export interface ScanProgress {
    scanned: number;
    total: number;
    found: number;
}

/** Final outcome of a completed scan. */
export interface ScanResult {
    found: number;
    noMemo: number;
    decryptFailed: number;
    alreadyPresent: number;
    /** Notes removed because their commitment was not found anywhere on-chain. */
    purged: number;
    /** Whether this was a full scan (from leafIndex 0) or an incremental one. */
    incremental: boolean;
    /**
     * Notes this wallet SENT, recovered during the same sweep.
     *
     * Free of extra requests — the outgoing ephPk window recognises our own
     * payments, and the change notes in the same feed carry the recipient keys
     * that open them. Feed them to `reconstructOutgoingTxRecords` to turn a
     * derived history row into the exact amount, plus a re-issued payment slip.
     */
    sentNotes: SentNoteMatch[];
    /**
     * How the scan found what it found — diagnostics, not results.
     *
     * The two fast routes recognise a note by hash lookup against a precomputed
     * window instead of a trial ECDH per hint, and they are the difference
     * between a scan that takes seconds and one that takes minutes. Both fail
     * SILENTLY: a window that never matches costs only speed, so the notes
     * quietly take the expensive path and nothing reports it.
     *
     * Surfaced here so a host can tell "the fast path is off" from "the fast
     * path ran". The counters existed before this and were accumulated where
     * nothing could read them.
     */
    discovery: {
        /** Own notes matched via the self-eph window (shields, change). */
        self: number;
        /** Notes from registered counterparties matched via their pairwise window. */
        pairwise: number;
        /** Hints rejected by the 1-byte view-tag filter, before any AEAD work. */
        tagFiltered: number;
    };
}
