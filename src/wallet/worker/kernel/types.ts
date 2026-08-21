/**
 * What crosses the worker boundary.
 *
 * Every value here must survive structured clone: it travels through
 * `postMessage` to a worker and back. That rules out classes, functions and
 * bigint-keyed maps — `bigint` itself is fine, `Uint8Array` is fine, anything
 * with a prototype is not.
 */
import type { ScanCommitment, ZkNote } from '../../../protocol/types';
import type { SentNoteFacts } from '../../../protocol/note/index';

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

/**
 * How many outgoing indexes a scan precomputes — how many payments back the
 * sender's own history reaches in one pass.
 *
 * A wallet that has sent more than this gets its window widened from the stored
 * counter, the same way `selfEphGap` widens the self window.
 */
export const OUTGOING_EPH_WINDOW = 64;

/** Wallet keys needed for trial-decryption. Structured-clone transferable. */
export interface ScanKeys {
    viewingKey: Uint8Array;
    spendingKey: bigint;
    ownerPk: bigint;
    /**
     * Outgoing viewing key (ovk), when this wallet can see what it sent.
     *
     * Its own capability: it seeds the outgoing ephemerals and opens the
     * recipient book, so a scan without it still finds every note the wallet
     * OWNS and simply reports no payment history. That is what a watch-only
     * wallet holding only the incoming viewing key gets.
     */
    outgoingViewingKey?: Uint8Array;
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
    /**
     * Recognise the notes this wallet SENT, by precomputing the outgoing ephPk
     * window from the OUTGOING viewing key.
     *
     * Not from the spending key: predicting these points IS the capability "see
     * what I sent", so it hangs off the branch that names it. Requires
     * `outgoingViewingKey` to be set.
     *
     * Enables the sender's own history: amount, recipient and a re-issuable
     * payment slip, none of which the chain exposes. Costs one EC mul per index
     * — worth it on a full scan or a restore, waste on an incremental tick.
     */
    outgoingEph?: boolean;
    /** Window size override (tests/tuning). Default OUTGOING_EPH_WINDOW. */
    outgoingEphWindowSize?: number;
    /**
     * Candidate recipients for opening a sent note, as packed viewing keys.
     *
     * The outgoing ephPk identifies the note without them, but the secret that
     * OPENS it is an ECDH against the recipient's key, so recovery tries each
     * candidate until the memo's MAC accepts one. Normally the recipient book
     * rebuilt from change notes; a wrong candidate cannot yield a wrong amount.
     */
    recipientCandidates?: Uint8Array[];
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
    /**
     * Highest OUTGOING index seen, or null.
     *
     * Feeds the same counter repair as `maxSelfEphIndex`: a restored wallet has
     * no stored counter, and starting again at 0 would republish the ephemeral
     * of its own first payment. Every index the scan matched is one this wallet
     * demonstrably published, so the maximum is a floor the counter must clear.
     */
    maxOutgoingEphIndex: number | null;
    /**
     * Notes this wallet SENT, recognised in the same sweep.
     *
     * A hint whose ephPk falls in the outgoing window is one of our own
     * payments. Kept apart from `notes` on purpose: the sender does not own it,
     * and putting it in the vault would show a payment they made as balance
     * they hold.
     */
    sentNotes: SentNoteMatch[];
    /**
     * Recipient viewing keys learned from payments opened in this batch, as
     * lowercase hex.
     *
     * Reported so the scan can feed them back as `recipientCandidates` — a
     * wallet that pays the same person twice opens the second payment from the
     * first one's key, even when its own change note is in another page.
     */
    learnedRecipients: string[];
    /**
     * Payments recognised as ours whose memo no candidate opened.
     *
     * Their book entry is in a change note this batch did not contain — a page
     * boundary between a payment and its change is enough. Reported rather than
     * dropped so the caller can retry them once more of the feed is read;
     * silently losing one costs a history row and a re-issuable slip forever.
     */
    unmatchedSent: UnmatchedSentHint[];
    /**
     * Sealed book entries seen in this batch, as raw `sourcePk` values.
     *
     * Still ciphertext: the key that opens one is the commitment of the PAYMENT
     * it names, which this batch may not contain. Reported so a caller holding
     * a stranded payment can try them against it — the pairing is only knowable
     * once both halves are in the same place.
     *
     * Serialised as decimal strings: `bigint` survives structured clone, but the
     * worker reply is host-written JSON in some hosts, where it would not.
     */
    sealedBookEntries: string[];
}

/**
 * A payment recognised by its outgoing ephPk but not yet opened.
 *
 * Carries only what a retry needs: the hint itself and the index its ephPk
 * matched, so the retry costs no second window lookup.
 */
export interface UnmatchedSentHint {
    hint: ScanCommitment;
    ephIndex: number;
}

/**
 * A note this wallet sent, plus what re-issuing its payment slip needs.
 *
 * The memo travels verbatim — a slip forwards it, never reads it — and the
 * counterparty key is who the fresh envelope is sealed toward. Both are already
 * in hand at the point of recovery, so carrying them costs nothing and spares
 * the caller a second lookup.
 */
export type SentNoteMatch = SentNoteFacts & {
    counterpartyIvkHex: string;
    /** The 180-byte encrypted memo, 0x-prefixed, exactly as published. */
    encryptedMemo: string;
};

/** An empty result — the shape both pool strategies return for zero hints. */
export const EMPTY_BATCH_RESULT: DecryptBatchResult = {
    notes: [],
    tagFiltered: 0,
    selfMatched: 0,
    pairwiseMatched: 0,
    maxSelfEphIndex: null,
    maxOutgoingEphIndex: null,
    sentNotes: [],
    learnedRecipients: [],
    unmatchedSent: [],
    sealedBookEntries: [],
};
