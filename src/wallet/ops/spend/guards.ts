/**
 * Pre-flight checks that turn opaque circuit failures into actionable errors.
 *
 * Every one of these conditions is already enforced by the circuit or the
 * pallet, but only after the caller has paid for proving — or for gas. The
 * failures are also unreadable at that point: a drifted note surfaces as
 * "assert failed" on a Merkle constraint, seconds into witness generation, with
 * nothing naming the note or the reason.
 */
import { computeNoteCommitment } from '../../../protocol/note/index';
import { isValidLeafIndex, LEAVES_PER_TREE } from '../../../protocol/spend/index';
import { deriveOwnerPk } from '../../../protocol/keys/PrivacyKeys';
import { fromHex } from '../../../foundation/encoding/hex';
import { bytesToBigintLE } from '../../../foundation/encoding/bytes';
import type { ZkNote } from '../../../protocol/types';
import type { PrivacyMerkleProof } from '../../../chain/rpc/types/index';

/**
 * Whether a note still matches the commitment stored on chain.
 *
 * The circuit ignores the ownerPk it is passed and rebuilds each input
 * commitment from BabyPbk(spending_key).Ax. If a note's stored spendingKey,
 * value, assetId or blinding drift from what was committed, the recomputed root
 * differs and witness generation dies on the Merkle constraint. Checking here
 * costs one EC multiplication plus a Poseidon hash — around 0.13 ms — against
 * seconds of proving that would fail anyway, and it names the real problem.
 */
export function noteMatchesCommitment(note: ZkNote): boolean {
    try {
        const recomputed = computeNoteCommitment(
            note.value,
            note.assetId,
            deriveOwnerPk(note.spendingKey),
            note.blinding
        );
        return recomputed === bytesToBigintLE(fromHex(note.commitmentHex));
    } catch {
        // A commitment that is not parseable hex cannot match anything, so the
        // answer is simply "no". Throwing here would escape `checkSpendableInputs`
        // — which every caller treats as returning a result rather than raising —
        // and turn a corrupt stored note into an unhandled rejection instead of a
        // message naming the note.
        return false;
    }
}

/**
 * Which forest tree a merkle proof belongs to.
 *
 * The same rule as `treeIdOf`, which answers it for a NOTE — this one reads a
 * proof, which carries `treeId` directly when the node supplies it and only
 * falls back to dividing the leaf index when it does not. Both go through
 * `LEAVES_PER_TREE` rather than a literal: a hardcoded depth here would silently
 * disagree with the protocol's and reject same-tree pairs as cross-tree.
 *
 * A malformed value must not be trusted: NaN compares unequal to itself and
 * would flag every pair as cross-tree, blocking valid transfers. Anything
 * outside u32 resolves to tree 0.
 */
export function treeOf(proof: PrivacyMerkleProof): number {
    const asU32 = (n: number | undefined) => (isValidLeafIndex(n) ? n : 0);
    return proof.treeId !== undefined
        ? asU32(proof.treeId)
        : Math.floor(asU32(proof.leafIndex) / LEAVES_PER_TREE);
}

export interface SpendableInputsCheck {
    ok: boolean;
    /** Present only when `ok` is false. Safe to show a user. */
    error?: string;
}

/**
 * Validates the input notes of a transfer before any proving work starts.
 *
 * Returns the first problem rather than throwing, because every caller here
 * turns a failure into a transaction result rather than an exception.
 */
export function checkSpendableInputs(notes: Array<ZkNote | undefined>): SpendableInputsCheck {
    const labels = ['A', 'B'];
    for (const [i, note] of notes.entries()) {
        if (!note) continue;
        if (!noteMatchesCommitment(note)) {
            return {
                ok: false,
                error:
                    `Input note ${labels[i] ?? i} does not match its on-chain commitment (wrong ` +
                    'spending key or corrupted note). The note cannot be spent; a vault rescan ' +
                    'may be required.',
            };
        }
    }

    const [a, b] = notes;
    if (a && b && b.circuitVersion !== a.circuitVersion) {
        return {
            ok: false,
            error:
                `Cannot transfer notes of different circuit versions (${a.circuitVersion} vs ` +
                `${b.circuitVersion}) in one proof.`,
        };
    }

    return { ok: true };
}
