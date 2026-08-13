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
 * it.
 *
 * **What each note records about the other party.** The two are deliberately
 * asymmetric, because they travel to different places:
 *
 *   - the RECIPIENT's note leaves this wallet, so it carries the spent note's
 *     pk only when that pk is one-time. Anything durable there would identify
 *     the sender to the recipient forever;
 *   - the CHANGE note never leaves: it is sealed to our own viewing key, and
 *     `NoteDisclosure` does not carry `sourcePk`. It always records who was
 *     paid, because it is the only way `reconstruct.ts` can name the payee
 *     after a vault loss.
 */
import { generateTransferProof } from '../../../protocol/proving/transfer';
import { buildDummyTransferInput } from '../../../protocol/spend/index';
import { CircuitType } from '@orbinum/proof-generator';
import { deriveViewingPublicKey, deriveViewingSecretKey } from '../../../protocol/keys/PrivacyKeys';
import { sealPaymentSlip, encodePaymentSlip } from '../../../protocol/memo/PaymentSlip';
import { fromHex, toHex } from '../../../foundation/encoding/hex';
import { bigintTo32LeArr } from '../../../foundation/encoding/bytes';
import { checkSpendableInputs, treeOf } from './guards';
import { failed, refuseIfAlreadySpent, markInputsSpent } from './lifecycle';
import type { SpendPrivacyReads, SpendVault } from './lifecycle';
import { stampCreatedTxHash, stampOrigin } from '../../vault/index';
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
        sourcePk: bigint;
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

/**
 * A transfer result, plus — for a transfer to another user — a `paymentSlip`:
 * the `orbslip1:` string the sender can hand the recipient so they rebuild their
 * note without scanning. Absent for self-transfers and change-only transfers.
 */
export type TransferResult = TxResult & { paymentSlip?: string };

export async function transferNotes(
    deps: TransferDeps,
    params: TransferParams,
    onProgress?: (step: TransferStep) => void
): Promise<TransferResult> {
    const { inputNotes, transferAmount, recipientPk, recipientViewingPublicKey } = params;
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

    // The change must be reopenable by a rescan under the sender's identity, so
    // its viewing key derives from the INPUT's spending key.
    const senderViewingPublicKey = deriveViewingPublicKey(
        deriveViewingSecretKey(noteA.spendingKey)
    );

    // What the recipient's memo may carry about us: the spent note's `ownerPk`,
    // but ONLY when it is a one-time key.
    //
    // A note that arrived by stealth has a per-transfer owner, so stamping it
    // reveals nothing durable. A note we shielded to ourselves does NOT: a
    // shield is self-addressed with no stealth derivation, so its `ownerPk` IS
    // this wallet's global identity. Stamping that would put a stable
    // identifier in the recipient's note — every payment we ever made from a
    // shielded note would link to the same pk, a recipient could match it
    // against our public privacy address, and a recipient disclosing one note
    // would expose us without our consent. Zcash puts nothing about the sender
    // in the recipient's note for exactly this reason.
    //
    // The condition was previously only asserted in a comment ("one-time by
    // construction when that note arrived by stealth") while the code stamped
    // `noteA.ownerPk` unconditionally — so the common shield→transfer path,
    // which is every new user's first payment, leaked the sender's identity.
    // Zero is the same value a shield/unshield note carries, and the recipient
    // already treats it as "no other party". The way to let a recipient pay
    // back is a payment slip, which the sender opts into and shares out of band.
    //
    // FAIL CLOSED. Two ways this can be unable to prove the key is one-time,
    // and both must withhold rather than stamp:
    //   - `selfOwnerPk` is null (keys not loaded): we cannot compare, so we
    //     cannot claim the key is not ours. Defaulting to "stamp" would leak
    //     precisely when the wallet knows least.
    //   - EITHER input is self-owned: the sender picks the input order, so a
    //     rule that only inspected `noteA` made the leak depend on which note
    //     landed in slot 0 — the same pair of notes could be spent two ways
    //     with different privacy.
    const inputsSpent = isDummy ? [noteA] : [noteA, noteB_!];
    const spentNoteIsOneTime =
        deps.selfOwnerPk !== null && inputsSpent.every((n) => n.ownerPk !== deps.selfOwnerPk);

    const recipientNote = await deps.buildNote({
        value: transferAmount,
        assetId: noteA.assetId,
        ownerPk: recipientPk,
        sourcePk: spentNoteIsOneTime ? noteA.ownerPk : 0n,
        // Undefined → dummy memo; the recipient finds the note by scanning.
        ...(recipientViewingPublicKey !== undefined
            ? { viewingPublicKey: recipientViewingPublicKey }
            : {}),
        // With a viewing key present this activates stealth derivation.
        recipientOwnerPk: recipientPk,
    });

    // No stealth for the change: the circuit validates the eventual spend by
    // BabyPbk(spendingKey).Ax === ownerPk, so the pair must be the sender's
    // real one.
    //
    // The change DOES record who we paid, and unlike the recipient note it is
    // not subject to the one-time rule — the asymmetry is the point:
    //
    //   - the recipient's note travels to SOMEONE ELSE, so anything durable in
    //     it identifies us to them (and to anyone they disclose it to);
    //   - the change note is ours, sealed to our own viewing key. Nobody else
    //     can open it, and `NoteDisclosure` does not carry `sourcePk`, so
    //     disclosing a note never exposes it either.
    //
    // It is also the ONLY way to reconstruct the payee after a vault loss: the
    // recipient's own memo is sealed toward them, so this stamp on our change
    // note is the sole copy a sender can still open, and `reconstruct.ts` reads
    // exactly this field. Blanking it to 0n would make
    // `hasSourcePk` treat the change as having no other party, so history
    // reconstruction would silently stop naming who was paid.
    const changeNote = await deps.buildNote({
        value: changeValue,
        assetId: noteA.assetId,
        ownerPk: noteA.ownerPk,
        spendingKey: noteA.spendingKey,
        sourcePk: recipientNote.ownerPk,
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
            await deps.vault.save(
                stampOrigin(
                    stampCreatedTxHash(changeNote, txResult.txHash, txKind),
                    'transfer-change'
                )
            );
        }

        const isSelf = deps.selfOwnerPk !== null && recipientPk === deps.selfOwnerPk;

        // Self-transfer: the recipient output is a stealth note only a rescan
        // would normally recover. We authored its memo, so recovering here makes
        // it spendable immediately. Recovery MUST use the wallet's global keys
        // (inside recoverStealth), never noteA's — an input received via an
        // earlier stealth transfer carries stealth keys that derive garbage.
        if (isSelf) {
            const selfNote = deps.recoverStealth(recipientNote);
            if (selfNote) {
                // A self-transfer's recipient output is a note we RECEIVED,
                // even though we also sent it.
                await deps.vault.save(
                    stampOrigin(
                        stampCreatedTxHash(selfNote, txResult.txHash, txKind),
                        'transfer-in'
                    )
                );
            }
        }

        // Payment slip: for a transfer to ANOTHER user (real memo, not a
        // self-transfer), seal the recipient output so the sender can hand it over
        // and the recipient rebuilds the note without scanning. leafIndex is
        // omitted — the recipient re-fetches the Merkle proof at spend time.
        // Best-effort: a slip is a convenience, so a failure to seal it must never
        // fail the transfer, which already landed on chain.
        if (recipientViewingPublicKey !== undefined && !isSelf) {
            try {
                const envelope = sealPaymentSlip(recipientViewingPublicKey, {
                    commitmentHex: recipientNote.commitmentHex,
                    encryptedMemo: toHex(Uint8Array.from(recipientNote.memo)),
                    ...(txResult.txHash ? { txHash: txResult.txHash } : {}),
                });
                return { ...txResult, paymentSlip: encodePaymentSlip(envelope) };
            } catch {
                // Leave the slip out; the transfer succeeded regardless.
            }
        }
    }

    return txResult;
}
