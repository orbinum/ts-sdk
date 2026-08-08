/**
 * Private transfer — one or two input notes to a recipient plus change.
 *
 * Two parts of this are the reason it lives in the SDK rather than in every
 * wallet separately:
 *
 * **The root reconciliation loop.** The circuit proves membership of both
 * inputs under ONE public merkle root, but each RPC fetch resolves under its
 * own best block. A commitment landing between the two fetches leaves the
 * proofs anchored to different roots, and witness generation dies on the
 * merkle constraint. The loop refetches until the roots agree — and it must
 * first rule out inputs from different forest trees, whose roots can NEVER
 * agree, or it would spend every retry on an impossible convergence.
 *
 * **Which key encrypts what.** The recipient note is encrypted to the
 * recipient's viewing key (stealth when they shared a privacy address); the
 * change note goes back to the sender under a viewing key derived from the
 * INPUT's spending key, so a rescan under the same identity can always reopen
 * it. The change note's counterpartyPk records the recipient's ONE-TIME
 * stealth key rather than their global one, so the vault never stores a stable
 * identifier of who was paid.
 */
import { generateTransferProof } from '../../../protocol/proving/transfer';
import { buildDummyTransferInput } from '../../../protocol/spend/index';
import { CircuitType } from '@orbinum/proof-generator';
import { deriveViewingPublicKey, deriveViewingSecretKey } from '../../../protocol/keys/PrivacyKeys';
import { fromHex } from '../../../foundation/encoding/hex';
import { bigintTo32LeArr } from '../../../foundation/encoding/bytes';
import { checkSpendableInputs, treeOf } from './guards';
import { failed, refuseIfAlreadySpent, markInputsSpent } from './lifecycle';
import type { SpendPrivacyReads, SpendVault } from './lifecycle';
import { stampCreatedTxHash } from '../../vault/index';
import type { TxKind } from '../../vault/index';
import type { ZkNote } from '../../../protocol/types';
import type { CircuitVersionResolver } from '../../../protocol/circuit-version/index';
import type { TxResult } from '../../../chain/client/types';
import type { PrivacyMerkleProof } from '../../../chain/rpc/index';

export type TransferStep =
    | 'checking-nullifiers'
    | 'fetching-merkle-proofs'
    | 'building-output-notes'
    | 'generating-zk'
    | 'submitting';

/** The extrinsic arguments, marshalled for whatever transport submits them. */
export interface TransferSubmitRequest {
    /** Exactly two — the circuit is 2-in/2-out; a single-note spend zero-pads slot B. */
    inputs: [
        { nullifier: number[]; commitment: number[] },
        { nullifier: number[]; commitment: number[] },
    ];
    outputs: [{ commitment: number[]; memo: number[] }, { commitment: number[]; memo: number[] }];
    proof: number[];
    merkleRoot: number[];
    assetId: number;
    fee: bigint;
    circuitVersion: number;
}

export interface TransferDeps {
    privacy: SpendPrivacyReads;
    resolver: Pick<CircuitVersionResolver, 'resolve'>;
    /** Builds the two output notes. Owns keys and the ephemeral reservations. */
    buildNote: (params: {
        value: bigint;
        assetId: bigint;
        ownerPk: bigint;
        spendingKey?: bigint;
        counterpartyPk: bigint;
        viewingPublicKey?: Uint8Array;
        recipientOwnerPk?: bigint;
    }) => Promise<ZkNote>;
    vault: SpendVault;
    /** Spendable form of a self-addressed stealth note, or null (see selfStealthNote). */
    recoverStealth: (note: ZkNote) => ZkNote | null;
    /** Submits the extrinsic. The host owns transport and lifecycle hooks. */
    submit: (request: TransferSubmitRequest) => Promise<TxResult>;
    /**
     * The wallet's loaded global ownerPk, or null. A transfer whose recipientPk
     * equals it is a SELF-transfer, whose stealth output is recovered and saved
     * immediately instead of waiting for a rescan.
     */
    selfOwnerPk: bigint | null;
    /** Route stamped on persisted notes (explorer link kind). */
    txKind?: TxKind;
}

export interface TransferParams {
    inputNotes: [ZkNote, ZkNote?];
    transferAmount: bigint;
    recipientPk: bigint;
    /** Packed viewing key from the recipient's privacy address. Omitted → dummy memo, they must scan. */
    recipientViewingPublicKey?: Uint8Array | undefined;
    senderPk?: bigint | undefined;
    fee?: bigint | undefined;
}

/**
 * Rounds of refetching before giving up on root agreement.
 *
 * Each round refetches A, and B only if that was not enough — so the ceiling is
 * six RPC calls, not three. Kept low deliberately: a tree advancing faster than
 * two fetches can converge is a chain under load, and retrying harder makes
 * that worse. The user retries a failed transfer; the node does not get a say.
 */
const MAX_ROOT_SYNC_ATTEMPTS = 3;

export async function transferNotes(
    deps: TransferDeps,
    params: TransferParams,
    onProgress?: (step: TransferStep) => void
): Promise<TxResult> {
    const { inputNotes, transferAmount, recipientPk, recipientViewingPublicKey, senderPk } = params;
    const effectiveFee = params.fee ?? 0n;
    const [noteA, noteB_] = inputNotes;
    const isDummy = !noteB_;
    const totalInput = noteA.value + (noteB_ ? noteB_.value : 0n);
    const changeValue = totalInput - transferAmount - effectiveFee;

    if (transferAmount <= 0n) return failed('Transfer amount must be greater than zero.');
    if (transferAmount > totalInput || changeValue < 0n) {
        return failed('Insufficient note value: transferAmount + fee exceeds sum of input notes.');
    }

    // Both inputs must still match what was committed on-chain and share a
    // circuit version — either failure would otherwise surface as an opaque
    // "assert failed" seconds into proving.
    const spendable = checkSpendableInputs([noteA, noteB_]);
    if (!spendable.ok) return failed(spendable.error!);

    // ── 1. Nullifier checks ───────────────────────────────────────────────────
    onProgress?.('checking-nullifiers');
    const inputs = isDummy ? [noteA] : [noteA, noteB_!];
    const alreadySpent = await refuseIfAlreadySpent(deps.privacy, deps.vault, inputs);
    if (alreadySpent) return alreadySpent;

    // ── 2. Merkle proofs ──────────────────────────────────────────────────────
    onProgress?.('fetching-merkle-proofs');
    let merkleA = await deps.privacy.getMerkleProofByCommitment(noteA.commitmentHex);
    let merkleB: PrivacyMerkleProof | null = null;

    if (isDummy) {
        // No second proof to reconcile against, but the tree can still advance
        // mid-fetch. Refetch once and keep the newer proof — a root that moved
        // means the first one was already stale.
        const refetched = await deps.privacy.getMerkleProofByCommitment(noteA.commitmentHex);
        if (refetched.root !== merkleA.root) merkleA = refetched;
    } else {
        merkleB = await deps.privacy.getMerkleProofByCommitment(noteB_!.commitmentHex);

        // Different forest trees anchor to different roots, which can never
        // agree — fail with the real reason instead of burning the retries.
        if (treeOf(merkleA) !== treeOf(merkleB)) {
            return failed(
                'Input notes live in different Merkle trees and cannot be spent together. ' +
                    'Consolidate them first (transfer each to yourself), then retry.'
            );
        }
        for (let i = 0; i < MAX_ROOT_SYNC_ATTEMPTS && merkleA.root !== merkleB.root; i++) {
            merkleA = await deps.privacy.getMerkleProofByCommitment(noteA.commitmentHex);
            if (merkleA.root === merkleB.root) break;
            merkleB = await deps.privacy.getMerkleProofByCommitment(noteB_!.commitmentHex);
        }
        if (merkleA.root !== merkleB.root) {
            return failed(
                'Merkle tree is advancing too quickly; could not fetch consistent proofs. ' +
                    'Please retry.'
            );
        }
    }

    const merkleRoot = merkleA.root;

    // ── 3. Output notes ───────────────────────────────────────────────────────
    onProgress?.('building-output-notes');
    const effectiveSenderPk = senderPk ?? noteA.ownerPk;

    // The change must be reopenable by a rescan under the sender's identity, so
    // its viewing key derives from the INPUT's spending key.
    const senderViewingPublicKey = deriveViewingPublicKey(
        deriveViewingSecretKey(noteA.spendingKey)
    );

    const recipientNote = await deps.buildNote({
        value: transferAmount,
        assetId: noteA.assetId,
        ownerPk: recipientPk,
        counterpartyPk: effectiveSenderPk,
        // Undefined → dummy memo; the recipient finds the note by scanning.
        ...(recipientViewingPublicKey !== undefined
            ? { viewingPublicKey: recipientViewingPublicKey }
            : {}),
        // With a viewing key present this activates stealth derivation.
        recipientOwnerPk: recipientPk,
    });

    // No stealth for the change: the circuit validates the eventual spend by
    // BabyPbk(spendingKey).Ax === ownerPk, so the pair must be the sender's
    // real one. counterpartyPk records the recipient's ONE-TIME stealth key —
    // never their stable global identifier.
    const changeNote = await deps.buildNote({
        value: changeValue,
        assetId: noteA.assetId,
        ownerPk: effectiveSenderPk,
        spendingKey: noteA.spendingKey,
        counterpartyPk: recipientNote.ownerPk,
        viewingPublicKey: senderViewingPublicKey,
    });

    // ── 4. Prove ──────────────────────────────────────────────────────────────
    onProgress?.('generating-zk');
    const noteToInput = (note: ZkNote, proof: PrivacyMerkleProof) => ({
        nullifier: note.nullifier,
        value: note.value,
        assetId: note.assetId,
        ownerPk: note.ownerPk,
        blinding: note.blinding,
        spendingKey: note.spendingKey,
        pathSiblings: proof.path,
        leafIndex: proof.leafIndex,
    });
    const noteToOutput = (note: ZkNote) => ({
        commitment: note.commitment,
        value: note.value,
        assetId: note.assetId,
        ownerPk: note.ownerPk,
        blinding: note.blinding,
    });

    const { provider, version: circuitVersion } = await deps.resolver.resolve(
        CircuitType.Transfer,
        noteA.circuitVersion
    );

    const proofResult = await generateTransferProof(
        {
            merkleRoot,
            inputs: [
                noteToInput(noteA, merkleA),
                isDummy ? buildDummyTransferInput(noteA.assetId) : noteToInput(noteB_!, merkleB!),
            ],
            outputs: [noteToOutput(recipientNote), noteToOutput(changeNote)],
            fee: effectiveFee,
        },
        { provider }
    );

    // ── 5. Submit ─────────────────────────────────────────────────────────────
    onProgress?.('submitting');
    const txResult = await deps.submit({
        inputs: [
            {
                nullifier: Array.from(fromHex(noteA.nullifierHex)),
                commitment: Array.from(fromHex(noteA.commitmentHex)),
            },
            {
                nullifier: isDummy
                    ? Array.from(new Uint8Array(32))
                    : Array.from(fromHex(noteB_!.nullifierHex)),
                commitment: isDummy
                    ? Array.from(new Uint8Array(32))
                    : Array.from(fromHex(noteB_!.commitmentHex)),
            },
        ],
        outputs: [
            {
                commitment: Array.from(bigintTo32LeArr(recipientNote.commitment)),
                memo: recipientNote.memo,
            },
            {
                commitment: Array.from(bigintTo32LeArr(changeNote.commitment)),
                memo: changeNote.memo,
            },
        ],
        proof: Array.from(fromHex(proofResult.proof)),
        merkleRoot: Array.from(fromHex(merkleRoot)),
        assetId: Number(noteA.assetId),
        fee: effectiveFee,
        circuitVersion,
    });

    // ── 6. Persist ────────────────────────────────────────────────────────────
    if (txResult.ok) {
        const txKind = deps.txKind ?? 'substrate';

        await markInputsSpent(deps.vault, inputs, txResult.txHash, txKind);

        // The change is ours — persist now, or the balance misses it until the
        // next rescan.
        if (changeValue > 0n) {
            await deps.vault.save(stampCreatedTxHash(changeNote, txResult.txHash, txKind));
        }

        // Self-transfer: the recipient output is a stealth note only a rescan
        // would normally recover. We authored its memo, so recovering here makes
        // it spendable immediately. Recovery MUST use the wallet's global keys
        // (inside recoverStealth), never noteA's — an input received via an
        // earlier stealth transfer carries stealth keys that derive garbage.
        if (deps.selfOwnerPk !== null && recipientPk === deps.selfOwnerPk) {
            const selfNote = deps.recoverStealth(recipientNote);
            if (selfNote) {
                await deps.vault.save(stampCreatedTxHash(selfNote, txResult.txHash, txKind));
            }
        }
    }

    return txResult;
}
