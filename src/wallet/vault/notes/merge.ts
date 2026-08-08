/**
 * Pure rules for the in-memory notes list: how a write reshapes it, and whether
 * a note is coherent enough to be worth storing.
 *
 * ## Why these are pure functions
 *
 * Every `VaultStore` mutation awaits — encrypt, then write — between reading the
 * notes and writing them back. A snapshot taken BEFORE those awaits is stale by
 * the time it lands: a concurrent write from that window is silently dropped
 * when the older snapshot replaces the whole array. Observed in practice as a
 * freshly shielded note disappearing while a rescan's `saveMany` re-encrypted
 * the vault around it.
 *
 * The fix is sequencing, and it belongs to the caller: do the async work first,
 * re-read the cache, then apply one of these synchronously through to `set`.
 * JavaScript is single-threaded, so with no await in that stretch nothing can
 * interleave. Taking the CURRENT list as an argument — never reading it from
 * anywhere — is what makes the guarantee checkable from the outside.
 */
import type { ZkNote } from '../../../protocol/types';
import { deriveOwnerPk } from '../../../protocol/keys/PrivacyKeys';

/**
 * Whether a note's spending key actually owns the commitment it claims.
 *
 * Every spend path rebuilds the commitment as
 * Poseidon(value, assetId, BabyPbk(spendingKey).Ax, blinding), so a note whose
 * `ownerPk` does not derive from its `spendingKey` can never be spent — it is
 * rejected with "does not match its on-chain commitment". The one way to
 * produce that pairing is storing a freshly built STEALTH note as-is: the
 * builder pairs the one-time stealthOwnerPk with the global spending key.
 */
export function isNoteSelfConsistent(note: ZkNote): boolean {
    return deriveOwnerPk(note.spendingKey) === note.ownerPk;
}

/**
 * Replaces the note sharing `note.commitmentHex`, or appends it when absent.
 *
 * Order is preserved for an existing note (an in-place replace) — the notes list
 * is rendered as-is, so re-ordering on a status change would make rows jump.
 */
export function upsertNote(notes: ZkNote[], note: ZkNote): ZkNote[] {
    let replaced = false;
    const next = notes.map((n) => {
        if (n.commitmentHex !== note.commitmentHex) return n;
        replaced = true;
        return note;
    });
    return replaced ? next : [...notes, note];
}

/**
 * Applies a batch of already-merged notes, keyed by commitment.
 *
 * Existing notes are replaced in place; unknown ones are appended in the batch's
 * own order. Notes absent from the batch are untouched — which is the point:
 * anything written concurrently survives instead of being replaced by a stale
 * snapshot of the whole array.
 */
export function applyBatch(notes: ZkNote[], batch: Map<string, ZkNote>): ZkNote[] {
    if (batch.size === 0) return notes;

    const applied = new Set<string>();
    const next = notes.map((n) => {
        const incoming = batch.get(n.commitmentHex);
        if (!incoming) return n;
        applied.add(n.commitmentHex);
        return incoming;
    });

    for (const [commitmentHex, note] of batch) {
        if (!applied.has(commitmentHex)) next.push(note);
    }
    return next;
}

/** Drops every note whose commitment is in `commitmentHexes`. */
export function removeByCommitment(notes: ZkNote[], commitmentHexes: Set<string>): ZkNote[] {
    if (commitmentHexes.size === 0) return notes;
    return notes.filter((n) => !commitmentHexes.has(n.commitmentHex));
}
