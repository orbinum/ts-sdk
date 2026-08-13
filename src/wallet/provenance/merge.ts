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
import type { NoteProvenanceRecord, ProvenanceSource } from './types';

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
 */
export function mergeProvenance(
    existing: NoteProvenanceRecord,
    incoming: NoteProvenanceRecord
): NoteProvenanceRecord {
    const incomingWins = outranks(incoming.source, existing.source);
    const base = incomingWins ? incoming : existing;
    const other = incomingWins ? existing : incoming;

    // Rule 2 — fill only the gaps the winner left, from either side. Optional
    // keys are SPREAD rather than assigned: under exactOptionalPropertyTypes an
    // explicit `undefined` is not the same as an absent key, and writing one
    // would make "no fee recovered" indistinguishable from "fee is undefined".
    const fee = base.feePlanck ?? other.feePlanck;
    const publicRecipient = base.publicRecipient ?? other.publicRecipient;
    const slip = base.slip ?? other.slip;
    const note = base.note ?? other.note;

    return {
        ...base,
        // A known peer beats an unknown one even when the winner is silent:
        // backfilling the recipient is the whole point of re-running this.
        peer: base.peer ?? other.peer,
        ...(fee !== undefined && { feePlanck: fee }),
        ...(publicRecipient !== undefined && { publicRecipient }),
        ...(slip !== undefined && { slip }),
        ...(note !== undefined && { note }),
    };
}
