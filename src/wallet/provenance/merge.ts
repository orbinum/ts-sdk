/**
 * Merging what a rescan learned into what the wallet already knew.
 *
 * The hazard this exists to remove: reconstruction runs after every scan, over
 * records the wallet may have written itself at submit time. Those local
 * records hold what a recovery path cannot: the amount and the recipient, which
 * live inside a memo sealed toward someone else. Overwriting one loses them.
 *
 * The payment slip itself is not at risk — it can be re-issued from public
 * fields — but a thin `chain` record must never replace a rich local one.
 *
 * Before this, the protection was a single spread expression in the
 * reconstruction loop. The rule is now explicit and testable on its own.
 */
import type {
    NoteProvenanceRecord,
    ProvenanceAmount,
    ProvenancePeer,
    ProvenanceSource,
} from './types';

/**
 * How much a record is trusted, by who wrote it. `witnessed` is the wallet's
 * own account of a transfer it submitted; nothing recovered later beats it.
 */
const SOURCE_RANK: Record<ProvenanceSource, number> = {
    witnessed: 3,
    memo: 2,
    chain: 1,
    inferred: 0,
};

/** Records come back from encrypted storage, so `source` is runtime data: a
 *  value this build does not know (older record, foreign writer) ranks lowest
 *  instead of poisoning the comparison with `undefined`. */
function rankOf(source: ProvenanceSource): number {
    return SOURCE_RANK[source] ?? -1;
}

export function outranks(a: ProvenanceSource, b: ProvenanceSource): boolean {
    return rankOf(a) > rankOf(b);
}

/**
 * Merge an incoming record into an existing one.
 *
 * Two rules, in order:
 *
 *  1. **A weaker source never overwrites a stronger one's facts.** An
 *     `inferred` backfill cannot replace the amount a `witnessed` record
 *     recorded at submit time.
 *  2. **Absence never overwrites presence.** Whatever the incoming record does
 *     not carry — a slip, a fee, a public recipient — is kept from the
 *     existing one regardless of rank, because "not recovered" is not "not
 *     there".
 *
 * Absence is not only `undefined`. Several fields spell "not known yet" with a
 * value: block and timestamp use `0`, `hash` and a slip's `encoded` use the
 * empty string, and a peer uses `scope: 'none'`. Those are gaps too, and
 * treating them as data let a placeholder win by rank — which is how a record
 * written before the chain confirmed could erase a block number already
 * resolved.
 *
 * Two fields sit outside the ranking entirely, because rank is the wrong
 * question for them: `status` is the chain's own outcome, and `amount.exact`
 * describes the figure rather than its source.
 */
export function mergeProvenance(
    existing: NoteProvenanceRecord,
    incoming: NoteProvenanceRecord
): NoteProvenanceRecord {
    // Two records only describe the same event if they share the storage key.
    // Merging across ids yields a row for a transaction that never happened —
    // one's amount under the other's hash. Callers normally look the existing
    // row up BY id, but that is their discipline, not a property of this
    // function, and the result would be indistinguishable from a real record.
    if (existing.id !== incoming.id) {
        throw new Error(
            `mergeProvenance: id mismatch — refusing to merge ${existing.id} with ${incoming.id}`
        );
    }

    const incomingWins = outranks(incoming.source, existing.source);
    const base = incomingWins ? incoming : existing;
    const other = incomingWins ? existing : incoming;

    // Rule 2 — fill only the gaps the winner left, from either side. Optional
    // keys are SPREAD rather than assigned: under exactOptionalPropertyTypes an
    // explicit `undefined` is not the same as an absent key, and writing one
    // would make "no fee recovered" indistinguishable from "fee is undefined".
    const fee = base.feePlanck ?? other.feePlanck;
    const publicRecipient = firstPresent(base.publicRecipient, other.publicRecipient);
    const slip = present(base.slip?.encoded) ? base.slip : (other.slip ?? base.slip);
    const note = base.note ?? other.note;

    // Nested values are COPIED, not shared. `{...base}` is shallow, so without
    // this the caller's result and the stored row point at the same `amount`,
    // `peer` and `slip` objects — and a caller who edits one field of the
    // result silently rewrites history that is still live in memory. For an
    // outgoing transfer that history is the only copy of the amount and the
    // recipient, so the aliasing is not a style question.
    return {
        // The loser is spread FIRST so a field only it carries survives. A host
        // stores its own record type through this — `ReconstructedTxRecord` has
        // `amountApproximate`, which marks an amount derived without subtracting
        // the fee — and dropping such a field turns an approximate figure into
        // one that merely looks exact. Every key the winner knows about is
        // overwritten below, so rank still decides every shared fact.
        ...other,
        ...base,
        // A known peer beats an unknown one even when the winner is silent:
        // backfilling the recipient is the whole point of re-running this.
        // `scope: 'none'` is "this operation has no counterparty", so it is a
        // gap too — treating it as known would block the backfill it exists for.
        peer: copyPeer(knownPeer(base.peer) ?? knownPeer(other.peer) ?? base.peer ?? other.peer),
        // A number that stands for "not known yet" must not win by rank. Zero is
        // exactly that here: `RECOVERED_TX_RESULT` and a failed submission both
        // report block 0, and their own comment says a caller who needs the
        // value must look it up rather than trust the field.
        blockNumber: firstPositive(base.blockNumber, other.blockNumber),
        timestampMs: firstPositive(base.timestampMs, other.timestampMs),
        // Reconstruction writes an empty hash when the extrinsic was not decoded.
        hash: firstPresent(base.hash, other.hash) ?? base.hash,
        // `exact` is a property of the FIGURE, not of the source. A `witnessed`
        // row whose amount was marked approximate is not better data than an
        // exact one from a weaker source, so rank only breaks a tie between two
        // figures of equal standing.
        amount: { ...betterAmount(base.amount, other.amount) },
        // The chain's outcome is not something one source knows better than
        // another — anyone who looks sees the same thing. Letting rank decide
        // would let a row written at submit time mark a transaction failed that
        // the chain went on to accept.
        status: base.status === 'success' || other.status === 'success' ? 'success' : 'failed',
        ...(fee !== undefined && { feePlanck: fee }),
        ...(publicRecipient !== undefined && { publicRecipient }),
        ...(slip !== undefined && { slip: { ...slip } }),
        ...(note !== undefined && { note: { ...note } }),
    };
}

/** The exact figure when only one side has it; otherwise the ranked winner's. */
function betterAmount(base: ProvenanceAmount, other: ProvenanceAmount): ProvenanceAmount {
    if (base.exact === other.exact) return base;
    return base.exact ? base : other;
}

/**
 * Is this string a value, or a placeholder for one that was never recovered?
 *
 * The empty string is the shape "not known" takes for `hash` and for a slip's
 * `encoded`. `??` does not catch it — the chain only skips null and undefined —
 * so an empty field counted as present and won by rank.
 */
function present(value: string | undefined): value is string {
    return value !== undefined && value.length > 0;
}

/** The first side that actually carries the string. */
function firstPresent(base: string | undefined, other: string | undefined): string | undefined {
    return present(base) ? base : present(other) ? other : undefined;
}

/** The first side whose number is a real value rather than the "unknown" zero. */
function firstPositive(base: number, other: number): number {
    return base > 0 ? base : other > 0 ? other : base;
}

/** A defensive copy, so the merged record shares no nested object. */
function copyPeer(peer: ProvenancePeer | null): ProvenancePeer | null {
    return peer ? { ...peer } : null;
}

/** A peer that names someone. `scope: 'none'` records the absence of one. */
function knownPeer(peer: ProvenancePeer | null): ProvenancePeer | null {
    return peer && peer.scope !== 'none' ? peer : null;
}
