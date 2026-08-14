/**
 * Which of an extrinsic's notes describes the transfer.
 *
 * One extrinsic can insert more than one note we own — a self-transfer produces
 * both the recipient note and the change. Taking whichever comes first would
 * report the change amount as the transfer amount, and an arbitrary one at
 * that, since vault order is insertion order.
 *
 * The rule: a note carrying a stamped `sourcePk` names the other party, so that
 * is the one that describes the transfer. In a self-transfer either note
 * qualifies, since both identify us.
 *
 * This was implemented twice — `findChangeNote` in the scanner and
 * `resolveIncomingTransferMeta` in the app, whose comment already admitted it
 * was copying the SDK. One rule, one place.
 */
import type { ZkNote } from '../../protocol/types';

/**
 * True when the note carries a `sourcePk` — i.e. it is not a shield/unshield
 * output, and not a transfer whose spent note had no one-time key to stamp.
 *
 * The type is checked, not just the value. Notes come back from encrypted
 * storage, and `normalizeNote` is what turns their scalars into bigints — but
 * this is public API and takes any object with the field, so a record that
 * skipped normalisation arrives with a string. `'0' != null && '0' !== 0n` is
 * true, so an unnormalised zero would read as a stamped key and pick the wrong
 * note: the CHANGE reported as the transfer amount, silently.
 */
export function hasSourcePk(note: Pick<ZkNote, 'sourcePk'>): boolean {
    return typeof note.sourcePk === 'bigint' && note.sourcePk !== 0n;
}

/**
 * Pick the note that describes the transfer, from the notes of ONE extrinsic
 * that this wallet owns. Returns undefined when it owns none of them.
 */
export function selectDescribingNote<T extends Pick<ZkNote, 'sourcePk'>>(
    candidates: T[]
): T | undefined {
    return candidates.find(hasSourcePk) ?? candidates[0];
}

/**
 * Same rule, resolving commitment hexes against a lookup first — the shape the
 * scanner has on hand. Commitments we do not own are skipped.
 */
export function selectDescribingNoteByCommitment<T extends Pick<ZkNote, 'sourcePk'>>(
    commitments: string[],
    noteByCommitment: Map<string, T>
): T | undefined {
    const owned = commitments
        .map((hex) => noteByCommitment.get(hex))
        .filter((note): note is T => note !== undefined);
    return selectDescribingNote(owned);
}
