/**
 * Repairing a note whose scalars survived a plain-JSON round trip.
 *
 * A `ZkNote` carries eight field elements as `bigint`. JSON has no bigint, so a
 * note that crossed a boundary without `vaultReplacer`/`vaultReviver` comes back
 * with some of them as strings or numbers. Nothing throws at that moment — the
 * failure lands later and elsewhere, as `Cannot mix BigInt and other types`
 * inside a balance sum or a fee subtraction, pointing at code that is fine.
 *
 * Two places produce such notes: records written before the bigint-safe
 * replacer existed, and any host that serialises notes through its own
 * transport. The replacer prevents the problem going forward; this repairs what
 * already exists.
 *
 * The field list belongs here because it is a fact about `ZkNote`, and a host
 * enumerating it independently would miss `sourcePk` — the one that is
 * optional on the way in and easy to overlook.
 */
import type { ZkNote } from '../../../protocol/types';

/**
 * The scalar fields of a note, as a list.
 *
 * `satisfies` rather than a bare array so adding a bigint field to `ZkNote`
 * without listing it here is a type error rather than a note that silently
 * normalises incompletely.
 */
export const NOTE_BIGINT_FIELDS = [
    'value',
    'assetId',
    'ownerPk',
    'blinding',
    'spendingKey',
    'commitment',
    'nullifier',
    'sourcePk',
] as const satisfies readonly (keyof ZkNote)[];

/**
 * Fields where an absent value means zero rather than damage.
 *
 * `sourcePk` is documented as "Zero for shield/unshield notes", and older
 * records simply omit it — those notes are perfectly good. Defaulting the rest
 * would not be: a `spendingKey` or `blinding` quietly set to `0n` rebuilds a
 * DIFFERENT commitment than the one on chain, so the note sits in the balance
 * as money that cannot move and fails seconds into proving on an assert that
 * names nothing.
 */
const ABSENT_MEANS_ZERO = new Set<string>(['sourcePk']);

/**
 * Coerces a note's scalars to `bigint`, or throws naming the field that cannot
 * be repaired.
 *
 * Throwing rather than defaulting is the point, for every field except those in
 * `ABSENT_MEANS_ZERO`: a note that cannot be read is better reported than
 * silently turned into one that looks spendable and is not.
 *
 * Returns the same object when every field is already a bigint, so a caller can
 * use identity to skip work.
 */
export function normalizeNote(note: ZkNote): ZkNote {
    let patch: Record<string, bigint> | null = null;
    for (const field of NOTE_BIGINT_FIELDS) {
        const raw = note[field];
        if (typeof raw === 'bigint') continue;
        if ((raw === undefined || raw === null) && ABSENT_MEANS_ZERO.has(field)) {
            (patch ??= {})[field] = 0n;
            continue;
        }
        try {
            (patch ??= {})[field] = BigInt(raw as string | number);
        } catch {
            throw new Error(
                `vault: note ${note.commitmentHex} has an unreadable ${field} ` +
                    `(${typeof raw}); the record is corrupt and a rescan is needed.`
            );
        }
    }
    return patch ? ({ ...note, ...patch } as ZkNote) : note;
}

/**
 * `normalizeNote` across a list, skipping notes that cannot be repaired.
 *
 * Unlike the single-note form this does NOT throw: a list usually comes from
 * storage, where one damaged record must not cost the user every other note.
 * `onSkipped` reports what was dropped so a host can surface it.
 */
export function normalizeNotes(
    notes: ZkNote[],
    onSkipped?: (note: ZkNote, error: unknown) => void
): ZkNote[] {
    const out: ZkNote[] = [];
    for (const note of notes) {
        try {
            out.push(normalizeNote(note));
        } catch (err) {
            onSkipped?.(note, err);
        }
    }
    return out;
}
