import { type PolkadotSigner } from 'polkadot-api';
import type { SubstrateClient } from '../../substrate/SubstrateClient';
import type { TxResult } from '../../client/types';
import {
    callUnsafeTx,
    resolveTx,
    toTxResult,
    submitBareTx,
    type UnsafeTxOptions,
} from '../../utils/tx';
import { EncryptedMemo } from '../protocol/EncryptedMemo';
import { accountIdHexToSs58 } from '../../utils/address';
import type {
    ShieldParams,
    UnshieldParams,
    PrivateTransferParams,
    ShieldBatchParams,
    ClaimShieldedFeesParams,
} from '../protocol/types';

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
     *
     * Shield is always a signed (public) transaction — the caller's address
     * appears on-chain as the depositor.
     */
    async shield(
        params: ShieldParams,
        signer: PolkadotSigner,
        txOptions?: UnsafeTxOptions
    ): Promise<TxResult> {
        EncryptedMemo.validate(params.encryptedMemo, 'shield.encryptedMemo');
        const entry = resolveTx(this.substrate.unsafe, 'ShieldedPool', 'shield');
        const tx = callUnsafeTx(entry, {
            asset_id: params.assetId,
            amount: params.amount,
            commitment: params.commitment,
            encrypted_memo: params.encryptedMemo,
        });
        return toTxResult(
            await (txOptions !== undefined
                ? tx.signAndSubmit(signer, txOptions)
                : tx.signAndSubmit(signer))
        );
    }

    /**
     * Withdraws tokens from the shielded pool to a public address.
     * Submits as an UNSIGNED (gasless) transaction — fee is embedded in the ZK proof.
     * Pass a `signer` to fall back to signed submission (e.g. for testing).
     * Extrinsic: shieldedPool.unshield(proof, merkleRoot, nullifier, assetId, amount, recipient, fee)
     */
    async unshield(
        params: UnshieldParams,
        signer?: PolkadotSigner,
        txOptions?: UnsafeTxOptions
    ): Promise<TxResult> {
        const entry = resolveTx(this.substrate.unsafe, 'ShieldedPool', 'unshield');
        // AccountId32 codec in PAPI expects SS58 string — convert from hex
        const recipientSs58 = accountIdHexToSs58(params.recipientAddress);
        if (!recipientSs58) throw new Error(`Invalid recipientAddress: ${params.recipientAddress}`);
        const changeCommitment = params.changeCommitment ?? '0x' + '00'.repeat(32);

        // Validate and encode change_encrypted_memo (if provided)
        let changeEncryptedMemo: Uint8Array;
        if (params.changeEncryptedMemo && params.changeEncryptedMemo.length > 0) {
            EncryptedMemo.validate(params.changeEncryptedMemo, 'changeEncryptedMemo');
            changeEncryptedMemo = params.changeEncryptedMemo;
        } else {
            // Empty memo for total unshield
            changeEncryptedMemo = new Uint8Array(0);
        }

        const tx = callUnsafeTx(entry, {
            proof: params.proof,
            merkle_root: params.merkleRoot,
            nullifier: params.nullifier,
            asset_id: params.assetId,
            amount: params.amount,
            recipient: recipientSs58,
            fee: params.fee ?? 0n,
            change_commitment: changeCommitment,
            change_encrypted_memo: changeEncryptedMemo,
            relayer: undefined, // Option<H160> — None for direct Substrate submissions
        });
        if (signer) {
            return toTxResult(
                await (txOptions !== undefined
                    ? tx.signAndSubmit(signer, txOptions)
                    : tx.signAndSubmit(signer))
            );
        }
        return submitBareTx(tx, this.substrate);
    }

    /**
     * Performs a private (shielded) transfer between two notes.
     * Submits as an UNSIGNED (gasless) transaction — fee is embedded in the ZK proof.
     * Pass a `signer` to fall back to signed submission (e.g. for testing).
     * Extrinsic: shieldedPool.privateTransfer(proof, merkleRoot, nullifiers, commitments, memos, assetId, fee)
     */
    async privateTransfer(
        params: PrivateTransferParams,
        signer?: PolkadotSigner,
        txOptions?: UnsafeTxOptions
    ): Promise<TxResult> {
        const nullifiers = params.inputs.map((inp) => inp.nullifier);
        const commitments = params.outputs.map((out) => out.commitment);
        const memos = params.outputs.map((out, i) => {
            EncryptedMemo.validate(
                out.encryptedMemo,
                `privateTransfer.outputs[${i}].encryptedMemo`
            );
            return out.encryptedMemo;
        });

        const entry = resolveTx(this.substrate.unsafe, 'ShieldedPool', 'private_transfer');
        const tx = callUnsafeTx(entry, {
            proof: params.proof,
            merkle_root: params.merkleRoot,
            nullifiers,
            commitments,
            encrypted_memos: memos,
            asset_id: params.assetId,
            fee: params.fee ?? 0n,
            relayer: undefined, // Option<H160> — None for direct Substrate submissions
        });
        if (signer) {
            return toTxResult(
                await (txOptions !== undefined
                    ? tx.signAndSubmit(signer, txOptions)
                    : tx.signAndSubmit(signer))
            );
        }
        return submitBareTx(tx, this.substrate);
    }

    /**
     * Deposits multiple notes into the shielded pool in a single extrinsic.
     * Extrinsic: shieldedPool.shieldBatch(operations) — max 20 items.
     */
    async shieldBatch(
        params: ShieldBatchParams,
        signer: PolkadotSigner,
        txOptions?: UnsafeTxOptions
    ): Promise<TxResult> {
        const operations = params.items.map((item, i) => {
            EncryptedMemo.validate(item.encryptedMemo, `shieldBatch.items[${i}].encryptedMemo`);
            return {
                assetId: item.assetId,
                amount: item.amount.toString(),
                commitment: item.commitment,
                encryptedMemo: item.encryptedMemo,
            };
        });
        const entry = resolveTx(this.substrate.unsafe, 'ShieldedPool', 'shield_batch');
        const tx = callUnsafeTx(entry, operations);
        return toTxResult(
            await (txOptions !== undefined
                ? tx.signAndSubmit(signer, txOptions)
                : tx.signAndSubmit(signer))
        );
    }

    /**
     * Claims accrued relay fees into the shielded pool.
     * This is a SIGNED transaction — the relayer must sign it with their wallet.
     * Before calling this, generate a ZK value proof with generateFeeClaimProof() (not yet implemented).
     *
     * Extrinsic: shieldedPool.claim_shielded_fees(commitment, amount, asset_id, memo, proof, public_signals)
     */
    async claimShieldedFees(
        params: ClaimShieldedFeesParams,
        signer: PolkadotSigner,
        txOptions?: UnsafeTxOptions
    ): Promise<TxResult> {
        EncryptedMemo.validate(params.encryptedMemo, 'claimShieldedFees.encryptedMemo');
        const entry = resolveTx(this.substrate.unsafe, 'ShieldedPool', 'claim_shielded_fees');
        const tx = callUnsafeTx(entry, {
            commitment: params.commitment,
            amount: params.amount,
            asset_id: params.assetId,
            encrypted_memo: params.encryptedMemo,
            proof: params.proof,
            public_signals: params.publicSignals,
        });
        return toTxResult(
            await (txOptions !== undefined
                ? tx.signAndSubmit(signer, txOptions)
                : tx.signAndSubmit(signer))
        );
    }
}
