/**
 * Private transfer — one or two input notes to a recipient plus change.
 *
 * Two things here are why this lives in the SDK and not in every wallet:
 *
 * **The root reconciliation loop.** The circuit proves both inputs under ONE
 * merkle root, but each RPC fetch resolves against its own best block. A
 * commitment landing between two fetches anchors the proofs to different roots
 * and witness generation dies on the merkle constraint. The loop refetches
 * until they agree — after first ruling out inputs from different forest trees,
 * whose roots can NEVER agree, or every retry is spent on the impossible.
 *
 * **Which key encrypts what.** The recipient note goes to the recipient's
 * viewing key (stealth when they shared a privacy address). The change note
 * goes to the sender's GLOBAL identity — never to anything derived from the
 * input — so a rescan under that identity can always reopen it.
 *
 * The change note's `sourcePk` carries the recipient book: their viewing key,
 * sealed under the sender's OUTGOING viewing key. Sealed, not plain, because a
 * viewing key is meant to be shareable and disclosing one must not hand over
 * the payment graph with it.
 */
import { generateTransferProof } from '../../../protocol/proving/transfer';
import { buildDummyTransferInput } from '../../../protocol/spend/index';
import { CircuitType } from '@orbinum/proof-generator';
import { sealPaymentSlip, encodePaymentSlip } from '../../../protocol/memo/PaymentSlip';
import { fromHex, toHex } from '../../../foundation/encoding/hex';
import { bigintTo32LeArr, bytesToBigintLE } from '../../../foundation/encoding/bytes';
import { sealRecipientBookEntry } from '../../../protocol/note/recipientBook';
import { checkSpendableInputs, treeOf } from './guards';
import { failed, refuseIfAlreadySpent, markInputsSpent } from './lifecycle';
import type { SpendPrivacyReads, SpendVault } from './lifecycle';
import { stampCreatedTxHash, stampCreatedBy } from '../../vault/index';
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
    /**
     * Builds the two output notes. Owns keys and the ephemeral reservations.
     *
     * Returns the outgoing index alongside the note, used only as a signal that
     * this payment published a DERIVED ephemeral and is therefore recoverable —
     * which is what decides whether the change note carries a book entry at all.
     * The entry itself is keyed on the payment's commitment, never on this
     * index; see `recipientBook`.
     */
    buildNote: (params: {
        value: bigint;
        assetId: bigint;
        /** Omit for a note owned by the wallet itself — the builder fills its own. */
        ownerPk?: bigint;
        spendingKey?: bigint;
        sourcePk: bigint;
        viewingPublicKey?: Uint8Array;
        recipientOwnerPk?: bigint;
    }) => Promise<{ note: ZkNote; outgoingIndex?: number }>;
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
    /**
     * The wallet's outgoing viewing key (ovk), when it has one.
     *
     * Seals the recipient book into the change note. Absent — a watch-only or
     * legacy identity — the change keeps the older meaning and the transfer is
     * simply not recoverable from the seed later.
     */
    outgoingViewingKey?: Uint8Array;
    /** Route stamped on persisted notes (explorer link kind). */
    txKind?: TxKind;
}

export interface TransferParams {
    inputNotes: [ZkNote, ZkNote?];
    transferAmount: bigint;
    recipientPk: bigint;
    /** Packed viewing key from the recipient's privacy address. Omitted → dummy memo, they must scan. */
    recipientViewingPublicKey?: Uint8Array | undefined;
    /**
     * What the recipient sees as `sourcePk` — who paid them.
     *
     * PASS IT EXPLICITLY. The default is the spent note's owner, so what gets
     * disclosed depends on coin selection: spending a received note discloses a
     * one-time key that names nobody, spending a shield or change note
     * discloses the wallet's GLOBAL identity, linkable across every payment
     * made from one. Naming the counterparty is the field's purpose, so neither
     * is a leak — but the choice should not be made by the coin selector.
     *
     * A stable pseudonym for a merchant tracking repeat payments, a
     * per-recipient value to stay unlinkable, or `0n` to say nothing.
     */
    senderPk?: bigint | undefined;
    fee?: bigint | undefined;
}

/**
 * Rounds of refetching before giving up on root agreement. Each round refetches
 * A, then B only if that was not enough — a ceiling of six RPC calls, not three.
 *
 * Low on purpose: a tree advancing faster than two fetches can converge means a
 * chain under load, and retrying harder makes that worse.
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

    const { note: recipientNote, outgoingIndex } = await deps.buildNote({
        value: transferAmount,
        assetId: noteA.assetId,
        ownerPk: recipientPk,
        sourcePk: effectiveSenderPk,
        // Undefined → dummy memo; the recipient finds the note by scanning.
        ...(recipientViewingPublicKey !== undefined
            ? { viewingPublicKey: recipientViewingPublicKey }
            : {}),
        // With a viewing key present this activates stealth derivation.
        recipientOwnerPk: recipientPk,
    });

    // The recipient book: the RECIPIENT'S VIEWING KEY sealed under the sender's
    // OUTGOING viewing key, riding in the change note's `sourcePk`. The change
    // is self-addressed and reopens from the seed alone, so this is what lets a
    // restored wallet name who it paid and re-issue the payment slip.
    //
    // Keyed on the PAYMENT's commitment — the one value both sides hold, and
    // the one a restored wallet has at the exact moment it needs the entry. An
    // index would drift: the entry is sealed against the outgoing sequence and
    // read while scanning the SELF sequence, and one shield separates them.
    //
    // Without a derived ephemeral it falls back to the recipient note's
    // `ownerPk`. That is a one-time stealth key when stealth engaged — but with
    // no `recipientViewingPublicKey` there is no stealth, and the fallback then
    // carries the recipient's GLOBAL key, linkable across every payment to
    // them. Same disclosure `senderPk` documents, on the other side.
    const changeSourcePk =
        outgoingIndex !== undefined &&
        recipientViewingPublicKey !== undefined &&
        deps.outgoingViewingKey !== undefined
            ? bytesToBigintLE(
                  sealRecipientBookEntry(
                      recipientViewingPublicKey,
                      deps.outgoingViewingKey,
                      recipientNote.commitmentHex
                  )
              )
            : recipientNote.ownerPk;

    // The change goes back to the wallet's GLOBAL identity, so its keys are
    // left to `buildNote`'s defaults and NEVER taken from the input note.
    //
    // Almost everything a wallet spends is a note it RECEIVED, and those are
    // stealth: one-time `spendingKey` and `ownerPk`. Change built from them is
    // sealed toward a viewing key derived from that one-time scalar, which a
    // rescan — holding the global key — cannot open, and commits to an owner
    // the wallet never derives again. Invisible at send time, since the change
    // is saved straight from memory; it surfaces on the next restore, as change
    // that simply is not there.
    //
    // No stealth for the change either: the circuit checks the eventual spend
    // by `BabyPbk(spendingKey).Ax === ownerPk`, so the pair must be the real one.
    const { note: changeNote } = await deps.buildNote({
        value: changeValue,
        assetId: noteA.assetId,
        sourcePk: changeSourcePk,
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
                stampCreatedBy(stampCreatedTxHash(changeNote, txResult.txHash, txKind), 'transfer')
            );
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

        // Payment slip: for a transfer to ANOTHER user (real memo, not a
        // self-transfer), seal the recipient output so the sender can hand it over
        // and the recipient rebuilds the note without scanning. leafIndex is
        // omitted — the recipient re-fetches the Merkle proof at spend time.
        // Best-effort: a slip is a convenience, so a failure to seal it must never
        // fail the transfer, which already landed on chain.
        const isSelf = deps.selfOwnerPk !== null && recipientPk === deps.selfOwnerPk;
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
