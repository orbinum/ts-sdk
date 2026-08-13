/**
 * Provenance a wallet keeps about a note: when it appeared, and which
 * transactions created and spent it.
 *
 * None of this is protocol — the chain neither stores nor needs it. It exists
 * so a wallet can show history, which is why it rides as extra properties on
 * the note object rather than widening `ZkNote`: `encryptNote` serialises the
 * whole note, so the fields survive the storage round trip on their own.
 *
 * Every reader here tolerates absence. A note from an older indexer chunk, or
 * one rebuilt from its memo, simply carries less.
 */
import type { ZkNote } from '../../../protocol/types';

/**
 * Which explorer route a note's tx hashes resolve under.
 *
 * Only the EVM precompile path produces an EVM hash, and only for operations
 * this wallet performed itself. Everything recovered from the scan feed is a
 * substrate extrinsic hash — hence the `substrate` default.
 */
export type TxKind = 'substrate' | 'evm';

export type NoteWithMeta = ZkNote & {
    /** On-chain creation time (ms) — block timestamp from the scan feed, or
     * local wall-clock for notes this wallet created itself. null/absent when
     * unknown (note scanned from a pre-v2 indexer chunk). */
    createdAt?: number | null;
    /** Hash of the tx that created this note — stamped locally when this wallet
     * created it, or recovered from the scan feed. null/absent when unknown
     * (pre-v3 indexer chunk, or an extrinsic the indexer could not resolve). */
    createdTxHash?: string | null;
    /** Hash of the tx that spent this note. Same two sources as `createdTxHash`:
     * local stamp on our own spend, or the nullifier set's parallel hash array. */
    spentTxHash?: string | null;
    /** Explorer route for both hashes above. Absent means substrate. */
    txKind?: TxKind;
};

/** Shield deposit vs PrivateTransfer output (received or change) — the memo's
 * sourcePk is zero only for shield/unshield-built notes. */
export function noteOrigin(note: ZkNote): 'shield' | 'private-transfer' {
    return note.sourcePk === 0n ? 'shield' : 'private-transfer';
}

export function noteCreatedAt(note: ZkNote): number | null {
    return (note as NoteWithMeta).createdAt ?? null;
}

export function stampCreatedAt(note: ZkNote, createdAt: number | null): ZkNote {
    return { ...note, createdAt } as NoteWithMeta;
}

// ─── Tx hashes ───────────────────────────────────────────────────────────────

export function noteCreatedTxHash(note: ZkNote): string | null {
    return (note as NoteWithMeta).createdTxHash ?? null;
}

export function noteSpentTxHash(note: ZkNote): string | null {
    return (note as NoteWithMeta).spentTxHash ?? null;
}

export function noteTxKind(note: ZkNote): TxKind {
    return (note as NoteWithMeta).txKind ?? 'substrate';
}

/**
 * Stamp the creating tx hash on a note.
 *
 * An empty or absent hash leaves the note untouched: a pre-submit failure
 * reports `txHash: ''`, and an indexer that could not resolve the extrinsic
 * sends null — storing either would render a dead explorer link.
 */
export function stampCreatedTxHash(
    note: ZkNote,
    txHash: string | null | undefined,
    txKind: TxKind = 'substrate'
): ZkNote {
    return txHash ? ({ ...note, createdTxHash: txHash, txKind } as NoteWithMeta) : note;
}

/**
 * Stamp the spending tx hash on a note. Same empty-hash rule as
 * `stampCreatedTxHash`, plus: an already-stamped note is left alone, so a
 * rescan can never overwrite the hash recorded when this wallet spent the note
 * itself.
 */
export function stampSpentTxHash(
    note: ZkNote,
    txHash: string | null | undefined,
    txKind: TxKind = 'substrate'
): ZkNote {
    if (!txHash || (note as NoteWithMeta).spentTxHash) return note;
    return { ...note, spentTxHash: txHash, txKind } as NoteWithMeta;
}

/**
 * Stamp wall-clock creation time on a note that was never stamped at all.
 *
 * `undefined` means no path ever set the field — a locally-created note that
 * bypassed buildZkNote (e.g. a self-transfer output reconstructed from its
 * memo via tryDecryptNote). An explicit `null` is different: the scan looked
 * up the chain timestamp and it was unknown — inventing "now" there would
 * date an old note as today, so null is preserved.
 */
export function ensureCreatedAt(note: ZkNote): ZkNote {
    return (note as NoteWithMeta).createdAt === undefined ? stampCreatedAt(note, Date.now()) : note;
}
