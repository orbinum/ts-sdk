import type { EvmClient } from '../evm/EvmClient';
import type {
    ShieldParams,
    UnshieldParams,
    PrivateTransferParams,
    ClaimShieldedFeesParams,
} from '../shielded-pool/protocol/types';
import type { EvmSigner } from './types';
import { EncryptedMemo } from '../shielded-pool/protocol/EncryptedMemo';
import { fromHex } from '../utils/hex';
import { encodeHex } from './abi';
import { PRECOMPILE_ADDR, SP_SEL } from './addresses';

// ─── ShieldedPoolPrecompile ───────────────────────────────────────────────────

/**
 * Bindings for the `ShieldedPoolPrecompile` at address `0x...0801`.
 *
 * This precompile wraps `pallet-shielded-pool` extrinsics and dispatches them
 * on behalf of the EVM caller (resolved to an AccountId32 via
 * `EeSuffixAddressMapping`). No Substrate signer is required — an EVM wallet
 * is sufficient.
 *
 * ### Key benefit for apps
 * EVM-only users (MetaMask, Phantom bridge via chain links, etc.) can shield,
 * transfer, and unshield without ever needing a Polkadot extension.
 *
 * All write methods accept an `EvmSigner` callback so the module stays
 * transport-agnostic. See `buildShieldCalldata` etc. if you only need the
 * raw calldata for custom signing flows.
 */
export class ShieldedPoolPrecompile {
    private readonly addr = PRECOMPILE_ADDR.SHIELDED_POOL;

    constructor(private readonly evm: EvmClient) {}

    // ─── shield ────────────────────────────────────────────────────────────────

    /**
     * Returns the ABI-encoded calldata for `shield(uint32, bytes32, bytes)`.
     * The token amount must be sent as `msg.value` (the `value` field of the EVM
     * transaction) — this is what MetaMask and other wallets display to the user.
     */
    buildShieldCalldata(params: ShieldParams): string {
        EncryptedMemo.validate(params.encryptedMemo, 'buildShieldCalldata.encryptedMemo');
        const commitment = fromHex(params.commitment);
        return encodeHex(
            SP_SEL.SHIELD,
            { type: 'uint', value: BigInt(params.assetId) },
            { type: 'bytes32', value: commitment },
            { type: 'bytes', value: params.encryptedMemo }
        );
    }

    /**
     * Deposits tokens into the shielded pool from a payable EVM transaction.
     *
     * The token amount is sent as `msg.value` so EVM wallets (MetaMask, etc.) display
     * the correct amount on the confirmation screen. The precompile dispatches
     * `shieldedPool.shield` with its own address as origin, so the funds flow:
     *   caller → precompile (via msg.value, handled by EVM)
     *   precompile → pool (via pallet transfer)
     * This avoids double-deduction while keeping the displayed amount accurate.
     *
     * Extrinsic: `shieldedPool.shield(assetId, amount, commitment, encryptedMemo)`
     */
    async shield(params: ShieldParams, signer: EvmSigner): Promise<string> {
        return signer({
            to: this.addr,
            data: this.buildShieldCalldata(params),
            value: params.amount,
        });
    }

    // ─── privateTransfer ───────────────────────────────────────────────────────

    /**
     * Returns the ABI-encoded calldata for
     * `privateTransfer(bytes, bytes32, bytes32[], bytes32[], bytes[], uint32, uint256)`.
     */
    buildPrivateTransferCalldata(params: PrivateTransferParams): string {
        const nullifiers = params.inputs.map((i) => fromHex(i.nullifier));
        const commitments = params.outputs.map((o) => fromHex(o.commitment));
        const memos = params.outputs.map((o, i) => {
            EncryptedMemo.validate(
                o.encryptedMemo,
                `buildPrivateTransferCalldata.outputs[${i}].encryptedMemo`
            );
            return o.encryptedMemo;
        });
        const root = fromHex(params.merkleRoot);

        return encodeHex(
            SP_SEL.PRIVATE_TRANSFER,
            { type: 'bytes', value: params.proof },
            { type: 'bytes32', value: root },
            { type: 'bytes32[]', value: nullifiers },
            { type: 'bytes32[]', value: commitments },
            { type: 'bytes[]', value: memos },
            { type: 'uint', value: BigInt(params.assetId) },
            { type: 'uint', value: params.fee ?? 0n }
        );
    }

    /**
     * Submits a private transfer within the shielded pool from an EVM transaction.
     *
     * The EVM caller identity is **irrelevant to the ZK proof** — the sender is
     * hidden by design. Any EVM address (including a relayer) can submit a valid proof.
     *
     * Extrinsic: `shieldedPool.privateTransfer(proof, merkleRoot, nullifiers, commitments, memos)`
     */
    async privateTransfer(params: PrivateTransferParams, signer: EvmSigner): Promise<string> {
        return signer({ to: this.addr, data: this.buildPrivateTransferCalldata(params) });
    }

    // ─── unshield ──────────────────────────────────────────────────────────────

    /**
     * Params for an `unshield` call via the EVM precompile.
     * The `recipient` is a full 32-byte AccountId32 (Substrate account or
     * EeSuffix-derived: `H160 ++ [0x00; 12]`).
     */
    buildUnshieldCalldata(params: UnshieldParams): string {
        const proof = params.proof;
        const root = fromHex(params.merkleRoot);
        const nullifier = fromHex(params.nullifier);

        // recipient must be exactly 32 bytes (AccountId32 encoded as bytes32)
        const recipientRaw = params.recipientAddress.startsWith('0x')
            ? params.recipientAddress.slice(2)
            : params.recipientAddress;
        const recipientBytes = fromHex(
            '0x' + (recipientRaw.length === 64 ? recipientRaw : recipientRaw.padEnd(64, '0'))
        );

        const changeCommitmentHex = params.changeCommitment ?? '0x' + '00'.repeat(32);
        const changeCommitment = fromHex(changeCommitmentHex);

        // changeEncryptedMemo: 176 bytes or empty (0-length) for total unshield
        const changeEncryptedMemo = params.changeEncryptedMemo ?? new Uint8Array();

        return encodeHex(
            SP_SEL.UNSHIELD,
            { type: 'bytes', value: proof },
            { type: 'bytes32', value: root },
            { type: 'bytes32', value: nullifier },
            { type: 'uint', value: BigInt(params.assetId) },
            { type: 'uint', value: params.amount },
            { type: 'bytes32', value: recipientBytes },
            { type: 'uint', value: params.fee ?? 0n },
            { type: 'bytes32', value: changeCommitment },
            { type: 'bytes', value: changeEncryptedMemo }
        );
    }

    /**
     * Withdraws tokens from the shielded pool to a recipient account.
     *
     * `params.recipientAddress` must be a 0x-prefixed 64-hex-char AccountId32.
     * To send to an EVM address, use `evmToImplicitSubstrate(evmAddr)` from
     * `@orbinum/sdk` to derive the AccountId32 first.
     *
     * Extrinsic: `shieldedPool.unshield(proof, merkleRoot, nullifier, assetId, amount, recipient)`
     */
    async unshield(params: UnshieldParams, signer: EvmSigner): Promise<string> {
        return signer({ to: this.addr, data: this.buildUnshieldCalldata(params) });
    }

    // ─── Gas estimation ────────────────────────────────────────────────────────

    /**
     * Estimates the EVM gas for a `shield` call without submitting.
     * Requires `from` to be set to the actual sender address.
     */
    async estimateShieldGas(params: ShieldParams, from: string): Promise<bigint> {
        return this.evm.estimateGas({
            from,
            to: this.addr,
            data: this.buildShieldCalldata(params),
        });
    }

    /**
     * Estimates the EVM gas for a `privateTransfer` call.
     */
    async estimatePrivateTransferGas(params: PrivateTransferParams, from: string): Promise<bigint> {
        return this.evm.estimateGas({
            from,
            to: this.addr,
            data: this.buildPrivateTransferCalldata(params),
        });
    }

    /**
     * Estimates the EVM gas for an `unshield` call.
     */
    async estimateUnshieldGas(params: UnshieldParams, from: string): Promise<bigint> {
        return this.evm.estimateGas({
            from,
            to: this.addr,
            data: this.buildUnshieldCalldata(params),
        });
    }

    // ─── claimShieldedFees ───────────────────────────────────────────────────────────────────

    /**
     * Returns the ABI-encoded calldata for
     * `claimShieldedFees(bytes32,uint256,uint32,bytes,bytes,bytes)`.
     *
     * ABI layout (params after selector):
     * - `commitment`    — bytes32 (fixed)
     * - `amount`        — uint256 (fixed)
     * - `asset_id`      — uint32  (fixed, right-aligned)
     * - `memo`          — bytes   (dynamic)
     * - `proof`         — bytes   (dynamic, 128 bytes Groth16)
     * - `publicSignals` — bytes   (dynamic, 76 bytes)
     *
     * The validator identity is derived from `msg.sender` in the precompile —
     * do NOT include it in the calldata.
     */
    buildClaimShieldedFeesCalldata(params: ClaimShieldedFeesParams): string {
        EncryptedMemo.validate(
            params.encryptedMemo,
            'buildClaimShieldedFeesCalldata.encryptedMemo'
        );

        if (params.proof.length === 0) {
            throw new Error('claimShieldedFees: proof must not be empty');
        }
        if (params.publicSignals.length !== 76) {
            throw new Error(
                `claimShieldedFees: publicSignals must be 76 bytes, got ${params.publicSignals.length}`
            );
        }

        const commitment = fromHex(params.commitment);

        return encodeHex(
            SP_SEL.CLAIM_SHIELDED_FEES,
            { type: 'bytes32', value: commitment },
            { type: 'uint', value: params.amount },
            { type: 'uint', value: BigInt(params.assetId) },
            { type: 'bytes', value: params.encryptedMemo },
            { type: 'bytes', value: params.proof },
            { type: 'bytes', value: params.publicSignals }
        );
    }

    /**
     * Claims accumulated relay fees as a private shielded note.
     *
     * This extrinsic is for **validators/relayers** who have accrued fees in
     * `pallet-relayer` and want to receive them privately inside the shielded pool
     * instead of as a public balance credit.
     *
     * The ZK `value_proof` binds `commitment` to `(amount, assetId, ownerPk, blinding)`
     * so the runtime can verify the note encodes exactly the claimed fee amount,
     * preventing a malicious relayer from inflating the withdrawal.
     *
     * The `msg.sender` EVM address is used as the validator identity; it must match
     * the address that has pending relay fees in `pallet-relayer`.
     *
     * Extrinsic: `shieldedPool.claim_shielded_fees(commitment, amount, assetId, memo, proof, publicSignals)`
     */
    async claimShieldedFees(params: ClaimShieldedFeesParams, signer: EvmSigner): Promise<string> {
        return signer({
            to: this.addr,
            data: this.buildClaimShieldedFeesCalldata(params),
        });
    }

    /**
     * Estimates the EVM gas for a `claimShieldedFees` call.
     */
    async estimateClaimShieldedFeesGas(
        params: ClaimShieldedFeesParams,
        from: string
    ): Promise<bigint> {
        return this.evm.estimateGas({
            from,
            to: this.addr,
            data: this.buildClaimShieldedFeesCalldata(params),
        });
    }
}
