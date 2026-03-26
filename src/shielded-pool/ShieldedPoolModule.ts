import { Binary, type PolkadotSigner, type TxFinalizedPayload } from 'polkadot-api';
import type { SubstrateClient } from '../substrate/SubstrateClient';
import type { MerkleModule } from './MerkleModule';
import { EncryptedMemo } from './EncryptedMemo';
import { NoteBuilder } from './NoteBuilder';
import type {
    ShieldParams,
    UnshieldParams,
    PrivateTransferParams,
    TxResult,
    NullifierStatus,
    PoolBalance,
    MerkleTreeInfo,
    NoteInput,
    ShieldResult,
} from '../types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toTxResult(payload: TxFinalizedPayload): TxResult {
    const base = {
        txHash: payload.txHash,
        blockHash: payload.block.hash,
        blockNumber: payload.block.number,
        ok: payload.ok,
    };
    if (!payload.ok) {
        return { ...base, error: payload.dispatchError.type };
    }
    return base;
}

/**
 * Calls a PAPI UnsafeApi tx entry with positional args.
 * UnsafeApi types tx calls as `[data: any]` (no descriptors available),
 * so we use this helper to preserve type safety outside the call site.
 */
function callUnsafeTx(
    txEntry: unknown,
    ...args: unknown[]
): { signAndSubmit(signer: PolkadotSigner): Promise<TxFinalizedPayload> } {
    return (
        txEntry as (...a: unknown[]) => {
            signAndSubmit(s: PolkadotSigner): Promise<TxFinalizedPayload>;
        }
    )(...args);
}

/** Retrieves a tx entry from the UnsafeApi, throwing if not found. */
function resolveTx(unsafe: unknown, pallet: string, call: string): unknown {
    const u = unsafe as Record<string, Record<string, Record<string, unknown>>>;
    const p = u['tx']?.[pallet] as Record<string, unknown> | undefined;
    if (p === undefined) throw new Error(`Pallet "${pallet}" not found in runtime metadata`);
    const entry = p[call];
    if (entry === undefined)
        throw new Error(`Call "${pallet}.${call}" not found in runtime metadata`);
    return entry;
}

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
    constructor(
        private readonly substrate: SubstrateClient,
        readonly merkle: MerkleModule
    ) {}

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

    // ─── Queries ───────────────────────────────────────────────────────────────

    /** Returns whether a nullifier has already been spent. */
    async isNullifierSpent(nullifierHex: string): Promise<boolean> {
        const raw = await this.substrate.request<{ is_spent: boolean }>(
            'privacy_getNullifierStatus',
            [nullifierHex]
        );
        return raw.is_spent;
    }

    /** Returns the full nullifier status object. */
    async getNullifierStatus(nullifierHex: string): Promise<NullifierStatus> {
        const raw = await this.substrate.request<{ nullifier: string; is_spent: boolean }>(
            'privacy_getNullifierStatus',
            [nullifierHex]
        );
        return { nullifier: raw.nullifier, isSpent: raw.is_spent };
    }

    /** Returns the total locked balance in the pool for a given asset. */
    async getPoolBalance(assetId: number): Promise<PoolBalance> {
        const raw = await this.substrate.request<{ balance: string | number }>(
            'shieldedPool_getPoolBalance',
            [assetId]
        );
        return { assetId, balance: BigInt(raw.balance) };
    }

    /**
     * Returns Merkle tree info and pool balance for a given asset in a single call.
     * Convenience wrapper used by both `app` and `privacy-explorer`.
     */
    async getPoolStats(assetId = 0): Promise<{ merkle: MerkleTreeInfo; balance: PoolBalance }> {
        const [merkle, balance] = await Promise.all([
            this.merkle.getTreeInfo(),
            this.getPoolBalance(assetId),
        ]);
        return { merkle, balance };
    }
}
