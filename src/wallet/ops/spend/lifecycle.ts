/**
 * The steps every spend shares, in the order a spend performs them.
 *
 * `transferNotes` and `unshieldNote` differ in what they prove and what they
 * submit, but they open and close identically: check the chain has not already
 * consumed the inputs, and — once it accepts the spend — record that those
 * inputs are gone.
 *
 * Both halves were written twice, and the duplication was not cosmetic. The
 * already-spent guard carries a MAGIC STRING that has to match the pallet's
 * wording for a caller's error classifier to fire, and the post-success marking
 * is what keeps the balance from counting money the chain already took. A rule
 * that has to hold in two files is a rule that eventually holds in one.
 */
import type { PrivacyMerkleProof } from '../../../chain/rpc/index';
import type { TxKind, VaultStore } from '../../vault/index';
import type { ZkNote } from '../../../protocol/types';
import type { TxResult } from '../../../chain/client/types';

/** The chain reads every spend needs: nullifier status and a Merkle proof. */
export interface SpendPrivacyReads {
    getNullifierStatus(nullifierHex: string): Promise<{ isSpent: boolean }>;
    getMerkleProofByCommitment(commitmentHex: string): Promise<PrivacyMerkleProof>;
}

/** The vault writes every spend performs. */
export type SpendVault = Pick<VaultStore, 'markSpent' | 'save'>;

/**
 * A failed spend, as a `TxResult`.
 *
 * Spends report failure as a value rather than an exception: a caller turns
 * every outcome into UI state, and a rejected spend is an expected one. The
 * empty `txHash` says no transaction exists to look up.
 */
export const failed = (error: string): TxResult => ({
    ok: false,
    txHash: '',
    blockHash: '0x',
    blockNumber: 0,
    error,
});

/**
 * Pallet wording for a nullifier the chain has already consumed.
 *
 * Reproduced verbatim so a caller's already-spent classifier fires on a
 * locally-detected collision exactly as it does on a chain rejection — the user
 * gets one message for one situation, however it was found.
 */
const ALREADY_SPENT = 'message: Some("NullifierAlreadySpent")';

/**
 * Refuses the spend when the chain says an input is already gone, reconciling
 * the vault on the way out.
 *
 * Runs BEFORE proving. The chain would reject the spend anyway, but only after
 * the caller has paid for a proof — and the vault would still believe the note
 * is spendable, so coin selection would keep offering it and every retry would
 * fail the same way.
 *
 * A failed `markSpent` is swallowed: the spend is being refused either way, and
 * losing the reconciliation is better than replacing a precise error with a
 * storage one.
 */
export async function refuseIfAlreadySpent(
    privacy: Pick<SpendPrivacyReads, 'getNullifierStatus'>,
    vault: Pick<SpendVault, 'markSpent'>,
    notes: ZkNote[]
): Promise<TxResult | null> {
    for (const note of notes) {
        const status = await privacy.getNullifierStatus(note.nullifierHex);
        if (status.isSpent) {
            await vault.markSpent(note.commitmentHex).catch(() => {});
            return failed(ALREADY_SPENT);
        }
    }
    return null;
}

/**
 * Records that the chain has consumed these inputs.
 *
 * Called only after a successful submit. Until it runs the notes still count
 * toward the balance AND stay selectable, so the user sees money that no longer
 * exists and the next spend dies on a duplicate nullifier. A rescan would fix
 * it eventually; "eventually" is the window this closes.
 */
export async function markInputsSpent(
    vault: Pick<SpendVault, 'markSpent'>,
    notes: ZkNote[],
    txHash: string,
    txKind: TxKind
): Promise<void> {
    for (const note of notes) {
        await vault.markSpent(note.commitmentHex, Date.now(), { txHash, txKind });
    }
}
