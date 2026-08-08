/**
 * What crosses the worker boundary.
 *
 * Every value here must survive structured clone: it travels through
 * `postMessage` to a worker and back. That rules out classes, functions and
 * bigint-keyed maps — `bigint` itself is fine, `Uint8Array` is fine, anything
 * with a prototype is not.
 */
import type { ZkNote } from '../../../protocol/types';

/**
 * Self-note discovery window: how many deterministic ephemeral indexes to
 * precompute. BIP-44-style gap limit — a wallet with more self-created notes
 * than this still finds the excess through the trial-decrypt path (correct,
 * just slower) until the counter syncs. Fixed size, no extension loop; add
 * one when a real wallet approaches this many self notes.
 */
export const SELF_EPH_WINDOW = 1024;

/**
 * Per-counterparty discovery window. Much smaller than the self window: this
 * counts payments from ONE sender, and a sender who outruns it just falls back
 * to the trial-decrypt path — correct, only slower — until the counter syncs.
 * The window costs two EC muls per index per sender, so it is the one number
 * that scales with how many people the wallet knows.
 */
export const PAIRWISE_EPH_WINDOW = 64;

/** Wallet keys needed for trial-decryption. Structured-clone transferable. */
export interface ScanKeys {
    viewingKey: Uint8Array;
    spendingKey: bigint;
    ownerPk: bigint;
    /**
     * First leafIndex from which every memo carries a view tag — hints at/after
     * it go through the 1-byte fast-scan filter (skip the AEAD decrypt on
     * mismatch). null/undefined = filter off (network not activated yet).
     */
    viewTagActivationLeaf?: number | null;
    /**
     * Enable self-note discovery: precompute the deterministic ephPk window and
     * recognize the wallet's own notes (shields, change) by hash lookup — zero
     * trial ECDH for them. Only worth its one-time window cost (two EC muls
     * per index) on full scans/restores; leave off for incremental ticks.
     */
    selfEph?: boolean;
    /** Window size override (tests/tuning). Default SELF_EPH_WINDOW. */
    selfEphWindowSize?: number;
    /**
     * Counterparties whose future payments can be recognized without an ECDH.
     *
     * A sender's key travels in the plaintext of the first payment they make us,
     * so once that one is decrypted the normal way, every later note from them
     * carries an ephemeral both sides derive — found by the same hash lookup as a
     * self note. A stranger's first payment is unaffected.
     *
     * Each entry is one packed viewing public key. Matching happens entirely on
     * this device: asking a server for a specific ephPk would tell it which notes
     * are ours, which is exactly what the download-everything feed prevents.
     */
    pairwiseCounterparties?: Uint8Array[];
    /** Per-counterparty window size. Default PAIRWISE_EPH_WINDOW. */
    pairwiseWindowSize?: number;
}

export interface DecryptBatchResult {
    /** One entry per hint, aligned with the input order (null = not ours). */
    notes: Array<ZkNote | null>;
    /** Hints discarded by the view-tag check alone — no AEAD work attempted. */
    tagFiltered: number;
    /** Hints recognized as own self-notes via the deterministic ephPk window. */
    selfMatched: number;
    /**
     * Hints recognized as coming from a known counterparty, via that sender's
     * precomputed window. Counted apart from `selfMatched` because it answers a
     * different question: whether the pairwise mechanism actually fired, or
     * whether those notes quietly fell through to the expensive path.
     */
    pairwiseMatched: number;
    /** Highest self-eph index seen (feeds the counter bump), or null. */
    maxSelfEphIndex: number | null;
}

/** An empty result — the shape both pool strategies return for zero hints. */
export const EMPTY_BATCH_RESULT: DecryptBatchResult = {
    notes: [],
    tagFiltered: 0,
    selfMatched: 0,
    pairwiseMatched: 0,
    maxSelfEphIndex: null,
};
