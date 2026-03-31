import { Binary, type PolkadotSigner } from 'polkadot-api';
import type { SubstrateClient } from '../substrate/SubstrateClient';
import type { TxResult } from '../client/types';
import { callUnsafeTx, resolveTx, toTxResult } from '../utils/tx';
import { EncryptedMemo } from './EncryptedMemo';
import { NoteBuilder } from './NoteBuilder';
import type {
    ShieldParams,
    UnshieldParams,
    PrivateTransferParams,
    NoteInput,
    ShieldResult,
    ShieldBatchParams,
} from './types';

// ─── ShieldedPoolModule ───────────────────────────────────────────────────────

/**
 * High-level module for Orbinum shielded-pool operations.
 *
 * Transactions are built via polkadot-api's UnsafeApi (metadata-driven),
 * which means the Orbinum node must be reachable on first use.
 * Signing is delegated to a PolkadotSigner (see polkadot-api/signer).
 *
 * Parameter order matches the Orbinum runtime extrinsics exactly.
 */
export class ShieldedPoolModule {
    constructor(private readonly substrate: SubstrateClient) {}

    // ─── Extrinsics ────────────────────────────────────────────────────────────

    /**
     * Deposits tokens into the shielded pool.
     * Extrinsic: shieldedPool.shield(assetId, amount, commitment, encryptedMemo)
     */
    async shield(params: ShieldParams, signer: PolkadotSigner): Promise<TxResult> {
        const memo = params.encryptedMemo ?? EncryptedMemo.dummy();
        const entry = resolveTx(this.substrate.unsafe, 'shieldedPool', 'shield');
        const tx = callUnsafeTx(
            entry,
            params.assetId,
            params.amount.toString(),
            Binary.fromHex(params.commitment),
            Binary.fromBytes(memo)
        );
        return toTxResult(await tx.signAndSubmit(signer));
    }

    /**
     * Build a ZkNote locally and submit shieldedPool.shield in one call.
     *
     * Returns both the on-chain result and the note — **save the note locally**,
     * it cannot be recovered after the fact.
     *
     * @param params.value       Amount in planck (required).
     * @param params.assetId     Asset ID — default 0 (native ORB-Privacy).
     * @param params.ownerPk     BabyJubJub Ax (default 0n).
     * @param params.blinding    Random blinding scalar (default BigInt(Date.now())).
     * @param params.spendingKey Secret spending key (default 0n).
     */
    async buildAndShield(
        params: {
            value: bigint;
            assetId?: number;
            ownerPk?: bigint;
            blinding?: bigint;
            spendingKey?: bigint;
        },
        signer: PolkadotSigner
    ): Promise<ShieldResult> {
        const noteInput: NoteInput = {
            value: params.value,
            ...(params.assetId !== undefined && { assetId: BigInt(params.assetId) }),
            ...(params.ownerPk !== undefined && { ownerPk: params.ownerPk }),
            ...(params.blinding !== undefined && { blinding: params.blinding }),
            ...(params.spendingKey !== undefined && { spendingKey: params.spendingKey }),
        };

        const note = await NoteBuilder.build(noteInput);
        const memo = NoteBuilder.buildMemo(note);

        const txResult = await this.shield(
            {
                assetId: Number(note.assetId),
                amount: note.value,
                commitment: note.commitmentHex,
                encryptedMemo: memo,
            },
            signer
        );

        return { txResult, note };
    }

    /**
     * Withdraws tokens from the shielded pool to a public address.
     * Extrinsic: shieldedPool.unshield(proof, merkleRoot, nullifier, assetId, amount, recipient)
     */
    async unshield(params: UnshieldParams, signer: PolkadotSigner): Promise<TxResult> {
        const entry = resolveTx(this.substrate.unsafe, 'shieldedPool', 'unshield');
        const tx = callUnsafeTx(
            entry,
            Binary.fromBytes(params.proof),
            Binary.fromHex(params.merkleRoot),
            Binary.fromHex(params.nullifier),
            params.assetId,
            params.amount.toString(),
            Binary.fromHex(params.recipientAddress)
        );
        return toTxResult(await tx.signAndSubmit(signer));
    }

    /**
     * Performs a private (shielded) transfer between two notes.
     * Extrinsic: shieldedPool.privateTransfer(inputs, outputs, proof, merkleRoot)
     */
    async privateTransfer(
        params: PrivateTransferParams,
        signer: PolkadotSigner
    ): Promise<TxResult> {
        const inputs = params.inputs.map((inp) => ({
            nullifier: Binary.fromHex(inp.nullifier),
            commitment: Binary.fromHex(inp.commitment),
        }));
        const outputs = params.outputs.map((out) => ({
            commitment: Binary.fromHex(out.commitment),
            memo: Binary.fromBytes(out.encryptedMemo ?? EncryptedMemo.dummy()),
        }));

        const entry = resolveTx(this.substrate.unsafe, 'shieldedPool', 'privateTransfer');
        const tx = callUnsafeTx(
            entry,
            inputs,
            outputs,
            Binary.fromBytes(params.proof),
            Binary.fromHex(params.merkleRoot)
        );
        return toTxResult(await tx.signAndSubmit(signer));
    }

    /**
     * Deposits multiple notes into the shielded pool in a single extrinsic.
     * Extrinsic: shieldedPool.shieldBatch(operations) — max 20 items.
     */
    async shieldBatch(params: ShieldBatchParams, signer: PolkadotSigner): Promise<TxResult> {
        const operations = params.items.map((item) => ({
            assetId: item.assetId,
            amount: item.amount.toString(),
            commitment: Binary.fromHex(item.commitment),
            encryptedMemo: Binary.fromBytes(item.encryptedMemo ?? EncryptedMemo.dummy()),
        }));
        const entry = resolveTx(this.substrate.unsafe, 'shieldedPool', 'shieldBatch');
        const tx = callUnsafeTx(entry, operations);
        return toTxResult(await tx.signAndSubmit(signer));
    }
}
