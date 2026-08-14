/**
 * NoteProvenance — the single vocabulary for "where did this note come from,
 * and where did it go".
 *
 * Several mechanisms answer that question, and before this module they had
 * separate vocabularies and no contract between them:
 *
 *   - the memo's `sourcePk` field, readable by whoever can decrypt the note
 *     (the recipient always; the sender only for the change note they kept);
 *   - a lookup by commitment, which returns only what is already public — no
 *     amount, no recipient, but enough to re-issue a payment slip.
 *
 * They are not competing designs. They are providers of the same fact, and
 * `ProvenanceSource` records which one spoke. Nothing here derives a key: this
 * layer only holds data already recovered.
 *
 * A sender cannot reopen a memo sealed toward someone else, so the amount and
 * recipient of an outgoing transfer are NOT recoverable from a seed alone. What
 * survives is the ability to hand the recipient a working slip again.
 */
import type { NoteFacts } from '../../protocol/types';

/**
 * Which operation produced a note.
 *
 * Replaces reading intent out of `sourcePk === 0n`, which had come to mean
 * three unrelated things at once: "shield or unshield", "an older record that
 * omitted the field", and "recipient not yet known". A note whose origin is
 * genuinely unknown says so.
 */
export type NoteOrigin =
    | 'shield'
    | 'transfer-in'
    | 'transfer-change'
    | 'unshield-change'
    | 'fee-claim'
    | 'unknown';

/**
 * Who wrote this record, and therefore how much to trust it.
 *
 * `witnessed` is the wallet's own account of a transfer it submitted — the
 * strongest, since nothing was recovered or guessed. `memo` is a decrypted
 * fact. `chain` is a lookup by commitment: trustworthy but thin, carrying only
 * public fields. `inferred` is arithmetic over the notes an extrinsic touched,
 * and is the only one that can be wrong about the amount.
 */
export type ProvenanceSource = 'witnessed' | 'memo' | 'chain' | 'inferred';

/**
 * What kind of public key `peer.pk` is.
 *
 * Orbinum stamps ONE-TIME stealth keys in memos on purpose — a stable
 * identifier in the recipient's note would link every payment from the same
 * sender forever. The UI needs to know which it holds: a global pk is an
 * address a user can act on, a stealth pk is a per-transfer artifact that
 * happens to look identical in hex.
 */
export type PkScope = 'global' | 'stealth' | 'none';

/** The other party to a transfer, with the nature of the key made explicit. */
export type ProvenancePeer = {
    /** BabyJubJub Ax coordinate. */
    pk: bigint;
    scope: PkScope;
};

/**
 * The amount moved, and whether that figure is exact.
 *
 * `exact` is a property of the FIGURE, not of the source: an `inferred` record
 * whose fee resolved is exact too. Keeping them separate is what lets the UI
 * mark an approximation without pretending to know where it came from.
 */
export type ProvenanceAmount = {
    /** Amount in planck. */
    value: bigint;
    /** False when the figure was derived and something in the derivation was unknown. */
    exact: boolean;
};

/**
 * One entry in the wallet's private history. Subsumes what used to be three
 * separate shapes: the app's `LocalTxRecord`, the scanner's
 * `ReconstructedTxRecord`, and the per-note facts a lookup returns.
 */
export type NoteProvenanceRecord = {
    /** Primary key — the tx hash, or `{block}-{index}` when it was not decoded. */
    id: string;
    /** 0x-prefixed extrinsic hash. Empty when the extrinsic could not be resolved. */
    hash: string;
    blockNumber: number;
    /** Unix ms. On-chain block time where known, local wall-clock otherwise. */
    timestampMs: number;

    /** Explicit direction — replaces `isIncoming`, `outgoing/incoming` and the rest. */
    direction: 'in' | 'out';
    kind: 'private_transfer' | 'unshield' | 'shield' | 'fee_claim';
    origin: NoteOrigin;
    source: ProvenanceSource;

    /** The other party, or null when this operation has none (shield, fee claim)
     *  or when no one-time key was available to record. */
    peer: ProvenancePeer | null;
    amount: ProvenanceAmount;
    assetId: bigint;
    status: 'success' | 'failed';
    /** Relay fee actually paid, when it could be read from the extrinsic. */
    feePlanck?: bigint;

    /** SS58 address that received the funds — unshield only. */
    publicRecipient?: string;
    /** The `orbslip1:` payment slip, when one was sealed or regenerated. */
    slip?: { encoded: string };
    /** The recovered note itself, when a decryption path produced one. */
    note?: NoteFacts;
};
