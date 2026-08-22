/**
 * Unshielding a note — full or partial — back to a public address.
 *
 * The delicate half is the PARTIAL case. The remainder becomes a stealth change
 * note: a fresh one-time ownerPk per unshield, so the change on-chain is
 * unlinkable to the wallet's global identity. The same ephemeral secret drives
 * both the memo encryption and the stealth-key derivation inside the builder,
 * which is why the memo the builder produced must be submitted VERBATIM —
 * a re-generated memo would carry a different ephemeral, the stealth key would
 * derive differently, and the change note would be unspendable.
 *
 * Everything environment-specific is injected: how notes are built, where the
 * vault lives, and how the extrinsic is submitted (substrate vs EVM routing is
 * the host's business).
 */
import { generateUnshieldProof } from '../../../protocol/proving/unshield';
import { CircuitType } from '@orbinum/proof-generator';
import { fromHex } from '../../../foundation/encoding/hex';
import { bigintTo32LeArr } from '../../../foundation/encoding/bytes';
import { randomBlinding } from '../../../foundation/crypto/blinding';
import { addressToAccountIdHex, addressToFieldElement } from '../../../foundation/address';
import { noteMatchesCommitment } from './guards';
import { failed, refuseIfAlreadySpent, markInputsSpent } from './lifecycle';
import type { SpendPrivacyReads, SpendVault } from './lifecycle';
import { stampCreatedTxHash, stampCreatedBy } from '../../vault/index';
import type { TxKind } from '../../vault/index';
import type { ZkNote } from '../../../protocol/types';
import type { CircuitVersionResolver } from '../../../protocol/circuit-version/index';
import type { TxResult } from '../../../chain/client/types';

export type UnshieldStep = 'fetching-proof' | 'checking-nullifier' | 'generating-zk' | 'submitting';

/** The extrinsic arguments, marshalled and ready for whatever transport submits them. */
export interface UnshieldSubmitRequest {
    proof: number[];
    merkleRoot: number[];
    nullifier: number[];
    assetId: number;
    amount: bigint;
    /** 0x-prefixed AccountId32 hex. */
    recipient: string;
    fee: bigint;
    changeCommitment: number[];
    changeEncryptedMemo?: number[];
    circuitVersion: number;
}

export interface UnshieldDeps {
    privacy: SpendPrivacyReads;
    resolver: Pick<CircuitVersionResolver, 'resolve'>;
    /**
     * Builds the stealth change note. Owns the keys it is built under.
     *
     * No ephemeral is reserved: passing `recipientOwnerPk` without a
     * `viewingPublicKey` takes neither the self nor the outgoing branch in
     * `buildZkNoteWithIndex`, so the note publishes a RANDOM ephemeral and a rescan
     * finds it by trial decryption rather than by index lookup.
     *
     * Shares its shape with the transfer's builder so one bound function serves
     * both; the outgoing index it may return is unused here, since an unshield
     * has no recipient to record.
     */
    buildNote: (params: {
        value: bigint;
        assetId: bigint;
        ownerPk: bigint;
        blinding: bigint;
        spendingKey: bigint;
        recipientOwnerPk: bigint;
    }) => Promise<{ note: ZkNote }>;
    vault: SpendVault;
    /**
     * The spendable form of a stealth note this wallet authored, or null. Null
     * means the built note must NOT be persisted — see the module comment.
     */
    recoverStealth: (note: ZkNote) => ZkNote | null;
    /** Submits the extrinsic. The host owns transport (substrate vs EVM) and lifecycle hooks. */
    submit: (request: UnshieldSubmitRequest) => Promise<TxResult>;
    /**
     * Keys the stealth change note is built under. The spending key must be the
     * wallet's GLOBAL one — the builder derives the one-time stealth key from
     * it via the memo's ephemeral, and a note-local key would derive garbage.
     */
    stealthKeys: { spendingKey: bigint; ownerPk: bigint };
    /** Route stamped on the persisted change note (explorer link kind). */
    txKind?: TxKind;
}

export interface UnshieldNoteParams {
    note: ZkNote;
    recipientAddress: string;
    /** Omitted → full withdrawal (note value minus fee). */
    amount?: bigint;
    fee: bigint;
}

export async function unshieldNote(
    deps: UnshieldDeps,
    params: UnshieldNoteParams,
    onProgress?: (step: UnshieldStep) => void
): Promise<TxResult> {
    const { note, recipientAddress, fee } = params;
    const amount = params.amount ?? (note.value > fee ? note.value - fee : 0n);
    const changeValue = note.value - amount - fee;

    if (amount <= 0n) return failed('Unshield amount must be greater than zero.');
    if (changeValue < 0n) return failed('Unshield amount + fee exceeds note value.');

    // The circuit rebuilds the commitment from BabyPbk(spending_key).Ax; a note
    // whose stored fields drifted dies seconds into witness generation with an
    // opaque assert. Checking here costs one hash and names the real problem.
    if (!noteMatchesCommitment(note)) {
        return failed(
            'Note data does not match its on-chain commitment (wrong spending key or corrupted ' +
                'note). Reconnect the wallet used to shield it, or run a vault rescan.'
        );
    }

    // Resolved before anything else can fail: an invalid recipient after proving
    // would waste the proof.
    const recipientAccountIdHex = addressToAccountIdHex(recipientAddress);
    if (!recipientAccountIdHex) return failed(`Invalid recipient address: ${recipientAddress}`);

    onProgress?.('checking-nullifier');
    const alreadySpent = await refuseIfAlreadySpent(deps.privacy, deps.vault, [note]);
    if (alreadySpent) return alreadySpent;

    onProgress?.('fetching-proof');
    const merkleProof = await deps.privacy.getMerkleProofByCommitment(note.commitmentHex);

    let changeNote: ZkNote | null = null;
    let changeBlinding = 0n;

    if (changeValue > 0n) {
        const { ownerPk, spendingKey } = deps.stealthKeys;
        changeBlinding = randomBlinding();

        changeNote = (
            await deps.buildNote({
                value: changeValue,
                assetId: note.assetId,
                ownerPk,
                blinding: changeBlinding,
                spendingKey,
                // Activates stealth: the commitment covers a one-time ownerPk.
                recipientOwnerPk: ownerPk,
            })
        ).note;
    }

    // Fail-closed: pins the prover to the note's version and cross-checks the VK
    // hash against the chain. Throws before proving on any mismatch.
    const { provider, version: circuitVersion } = await deps.resolver.resolve(
        CircuitType.Unshield,
        note.circuitVersion
    );

    onProgress?.('generating-zk');
    const recipientBigint = addressToFieldElement(recipientAddress);
    const proofResult = await generateUnshieldProof(
        {
            merkleRoot: merkleProof.root,
            nullifier: note.nullifier,
            amount,
            assetId: note.assetId,
            recipient: recipientBigint,
            blinding: note.blinding,
            spendingKey: note.spendingKey,
            pathSiblings: merkleProof.path,
            leafIndex: merkleProof.leafIndex,
            fee,
            // Omitted rather than undefined: the prover distinguishes "no
            // change output" from an explicit value.
            ...(changeNote !== null
                ? { changeValue, changeBlinding, changeOwnerPubkey: changeNote.ownerPk }
                : {}),
        },
        { provider }
    );

    onProgress?.('submitting');
    const changeEncryptedMemo = changeNote !== null ? changeNote.memo : [];
    const txResult = await deps.submit({
        proof: Array.from(fromHex(proofResult.proof)),
        merkleRoot: Array.from(fromHex(merkleProof.root)),
        nullifier: Array.from(fromHex(note.nullifierHex)),
        assetId: Number(note.assetId),
        amount,
        recipient: recipientAccountIdHex,
        fee,
        // The proof generator's change commitment is authoritative — it is what
        // the proof actually covers.
        changeCommitment:
            proofResult.changeValue > 0n
                ? Array.from(bigintTo32LeArr(proofResult.changeCommitment))
                : new Array<number>(32).fill(0),
        ...(changeEncryptedMemo.length > 0 ? { changeEncryptedMemo } : {}),
        circuitVersion,
    });

    if (txResult.ok) {
        const txKind = deps.txKind ?? 'substrate';

        await markInputsSpent(deps.vault, [note], txResult.txHash, txKind);

        // The built change note carries the global spending key against a stealth
        // ownerPk — a combination no spend path accepts. Recovery re-derives the
        // stealth key from the memo, the same way a rescan would; a null recovery
        // means persisting nothing and letting the rescan pick it up.
        if (changeNote && changeValue > 0n) {
            const spendable = deps.recoverStealth(changeNote);
            if (spendable) {
                await deps.vault.save(
                    stampCreatedBy(
                        stampCreatedTxHash(spendable, txResult.txHash, txKind),
                        'unshield'
                    )
                );
            }
        }
    }

    return txResult;
}
