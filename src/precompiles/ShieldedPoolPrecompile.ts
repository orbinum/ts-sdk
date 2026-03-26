import type { EvmClient } from '../evm/EvmClient';
import type { ShieldParams, UnshieldParams, PrivateTransferParams } from '../types';
import { EncryptedMemo } from '../shielded-pool/EncryptedMemo';
import { fromHex, toHex } from '../utils/hex';
import { encodeHex } from './abi';
import { PRECOMPILE_ADDR, SP_SEL } from './addresses';

// ─── EvmSigner ────────────────────────────────────────────────────────────────

/** EVM transaction request passed to an `EvmSigner` callback. */
export type EvmTxRequest = {
    to: string;
    data: string; // 0x-prefixed calldata
    value?: bigint; // ETH value in wei (0 for shielded pool calls)
};

/**
 * Callback that signs and submits an EVM transaction, returning the tx hash.
 *
 * MetaMask: `(tx) => window.ethereum.request({ method: 'eth_sendTransaction', params: [{ ...tx, from: account }] })`
 * ethers:   `(tx) => (await signer.sendTransaction({ to: tx.to, data: tx.data })).hash`
 * viem:     `(tx) => walletClient.sendTransaction({ to: tx.to, data: tx.data })`
 */
export type EvmSigner = (tx: EvmTxRequest) => Promise<string>;

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
     * Returns the ABI-encoded calldata for `shield(uint32, uint256, bytes32, bytes)`.
     * Useful when you need to inspect or batch the calldata before sending.
     */
    buildShieldCalldata(params: ShieldParams): string {
        const memo = params.encryptedMemo ?? EncryptedMemo.dummy();
        const commitment = fromHex(params.commitment);
        return encodeHex(
            SP_SEL.SHIELD,
            { type: 'uint', value: BigInt(params.assetId) },
            { type: 'uint', value: params.amount },
            { type: 'bytes32', value: commitment },
            { type: 'bytes', value: memo }
        );
    }

    /**
     * Deposits tokens into the shielded pool from an EVM transaction.
     *
     * The EVM caller's address is deterministically mapped to a Substrate
     * AccountId32 (`H160 ++ [0x00; 12]`). The pool deducts from that account.
     *
     * Extrinsic: `shieldedPool.shield(assetId, amount, commitment, encryptedMemo)`
     */
    async shield(params: ShieldParams, signer: EvmSigner): Promise<string> {
        return signer({ to: this.addr, data: this.buildShieldCalldata(params) });
    }

    // ─── privateTransfer ───────────────────────────────────────────────────────

    /**
     * Returns the ABI-encoded calldata for
     * `privateTransfer(bytes, bytes32, bytes32[], bytes32[], bytes[])`.
     */
    buildPrivateTransferCalldata(params: PrivateTransferParams): string {
        const nullifiers = params.inputs.map((i) => fromHex(i.nullifier));
        const commitments = params.outputs.map((o) => fromHex(o.commitment));
        const memos = params.outputs.map((o) => o.encryptedMemo ?? EncryptedMemo.dummy());
        const root = fromHex(params.merkleRoot);

        return encodeHex(
            SP_SEL.PRIVATE_TRANSFER,
            { type: 'bytes', value: params.proof },
            { type: 'bytes32', value: root },
            { type: 'bytes32[]', value: nullifiers },
            { type: 'bytes32[]', value: commitments },
            { type: 'bytes[]', value: memos }
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

        return encodeHex(
            SP_SEL.UNSHIELD,
            { type: 'bytes', value: proof },
            { type: 'bytes32', value: root },
            { type: 'bytes32', value: nullifier },
            { type: 'uint', value: BigInt(params.assetId) },
            { type: 'uint', value: params.amount },
            { type: 'bytes32', value: recipientBytes }
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
}

// ─── Re-export for convenience ────────────────────────────────────────────────
export { toHex };
