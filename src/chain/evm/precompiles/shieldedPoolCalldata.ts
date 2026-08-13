/**
 * Calldata for the shielded-pool precompile: params in, ABI-encoded hex out.
 *
 * Kept apart from `ShieldedPoolPrecompile` because building calldata needs no
 * chain connection — it is a pure function of the params. The class owns the
 * transport (signer, gas estimation, the precompile address); this owns the
 * bytes. Anyone signing through their own flow can import these directly
 * instead of constructing a client they never call.
 *
 * ## Validation lives here
 *
 * The ABI encoder is total: it left-pads whatever it is handed into a 32-byte
 * word. That makes silent corruption the default failure mode — an empty
 * string becomes 32 zero bytes, and a number past 2^32 becomes a word the node
 * reads back truncated. Both produce calldata the chain rejects for reasons the
 * user cannot act on, so every value is refused HERE, at the last point where
 * the field name is still known and can go in the error message.
 */
import type {
    ShieldParams,
    UnshieldParams,
    PrivateTransferParams,
    ClaimShieldedFeesParams,
} from '../../pallet/shielded-pool/extrinsicParams';
import { EncryptedMemo } from '../../../protocol/memo/index';
import { fromHex, isHexOfLength } from '../../../foundation/encoding/hex';
import { encodeHex } from './abi';
import { SP_SEL } from './addresses';

/** Groth16 public signals for a fee claim, in bytes. */
const CLAIM_PUBLIC_SIGNALS_SIZE = 76;

// ─── Field guards ────────────────────────────────────────────────────────────

/**
 * A `bytes32` ABI slot, from exactly 32 bytes.
 *
 * Throws rather than returning null, unlike the boundary checks in `protocol/`:
 * this is the wallet's own outgoing calldata, so a bad value is a bug in the
 * caller, not hostile input to tolerate.
 */
function bytes32(hex: string, field: string): Uint8Array {
    if (!isHexOfLength(hex, 32)) {
        throw new Error(`${field}: expected a 0x-prefixed 32-byte hex string, got ${hex}`);
    }
    return fromHex(hex);
}

/**
 * A `uint32` ABI slot, checked against the width the chain actually decodes.
 *
 * The slot is 32 bytes wide, so an oversized value encodes cleanly and is then
 * truncated on the far side: `2^32` reads back as `0`. For `circuitVersion`
 * that silently selects a DIFFERENT verifying key than the caller asked for.
 */
function uint32(value: number, field: string): bigint {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
        throw new Error(`${field}: expected a uint32 (0..4294967295), got ${value}`);
    }
    return BigInt(value);
}

/**
 * A 32-byte AccountId32 slot from a recipient address.
 *
 * Short input is right-padded, which is what an `EeSuffix` address is: an H160
 * followed by twelve zero bytes. Anything LONGER is refused instead of being
 * truncated — silently dropping the tail would pay a different account.
 */
function accountId32(address: string, field: string): Uint8Array {
    const raw = address.startsWith('0x') ? address.slice(2) : address;
    if (raw.length > 64) {
        throw new Error(`${field}: expected at most 32 bytes, got ${raw.length / 2}`);
    }
    return bytes32('0x' + raw.padEnd(64, '0'), field);
}

// ─── Builders ────────────────────────────────────────────────────────────────

/**
 * Calldata for `shield(uint32, bytes32, bytes)`.
 *
 * The token amount is NOT here: it rides as `msg.value` on the transaction, so
 * EVM wallets show the user the amount they are actually sending.
 */
export function buildShieldCalldata(params: ShieldParams): string {
    EncryptedMemo.validate(params.encryptedMemo, 'buildShieldCalldata.encryptedMemo');
    const commitment = bytes32(params.commitment, 'buildShieldCalldata.commitment');

    return encodeHex(
        SP_SEL.SHIELD,
        { type: 'uint', value: uint32(params.assetId, 'buildShieldCalldata.assetId') },
        { type: 'bytes32', value: commitment },
        { type: 'bytes', value: params.encryptedMemo }
    );
}

/**
 * Calldata for
 * `privateTransfer(bytes, bytes32, bytes32[], bytes32[], bytes[], uint32, uint256, uint32)`.
 *
 * Eight arguments, ending in the circuit version the input notes were created
 * under. The argument count is part of the selector: a ninth would change it,
 * and the precompile answers only to `0x66ed2cd4`.
 */
export function buildPrivateTransferCalldata(params: PrivateTransferParams): string {
    const nullifiers = params.inputs.map((input, i) =>
        bytes32(input.nullifier, `buildPrivateTransferCalldata.inputs[${i}].nullifier`)
    );
    const commitments = params.outputs.map((output, i) =>
        bytes32(output.commitment, `buildPrivateTransferCalldata.outputs[${i}].commitment`)
    );
    const memos = params.outputs.map((output, i) => {
        EncryptedMemo.validate(
            output.encryptedMemo,
            `buildPrivateTransferCalldata.outputs[${i}].encryptedMemo`
        );
        return output.encryptedMemo;
    });
    const root = bytes32(params.merkleRoot, 'buildPrivateTransferCalldata.merkleRoot');

    return encodeHex(
        SP_SEL.PRIVATE_TRANSFER,
        { type: 'bytes', value: params.proof },
        { type: 'bytes32', value: root },
        { type: 'bytes32[]', value: nullifiers },
        { type: 'bytes32[]', value: commitments },
        { type: 'bytes[]', value: memos },
        { type: 'uint', value: uint32(params.assetId, 'buildPrivateTransferCalldata.assetId') },
        { type: 'uint', value: params.fee ?? 0n },
        {
            type: 'uint',
            value: uint32(params.circuitVersion, 'buildPrivateTransferCalldata.circuitVersion'),
        }
    );
}

/**
 * Calldata for `unshield(...)`.
 *
 * `recipientAddress` is a full 32-byte AccountId32 — a Substrate account, or an
 * EeSuffix-derived one (`H160 ++ [0x00; 12]`). A total unshield leaves no
 * change, which is encoded as a zero commitment and an empty memo rather than
 * as an absent field.
 */
export function buildUnshieldCalldata(params: UnshieldParams): string {
    const root = bytes32(params.merkleRoot, 'buildUnshieldCalldata.merkleRoot');
    const nullifier = bytes32(params.nullifier, 'buildUnshieldCalldata.nullifier');
    const recipient = accountId32(
        params.recipientAddress,
        'buildUnshieldCalldata.recipientAddress'
    );

    const changeCommitment = bytes32(
        params.changeCommitment ?? '0x' + '00'.repeat(32),
        'buildUnshieldCalldata.changeCommitment'
    );
    const changeEncryptedMemo = params.changeEncryptedMemo ?? new Uint8Array();

    return encodeHex(
        SP_SEL.UNSHIELD,
        { type: 'bytes', value: params.proof },
        { type: 'bytes32', value: root },
        { type: 'bytes32', value: nullifier },
        { type: 'uint', value: uint32(params.assetId, 'buildUnshieldCalldata.assetId') },
        { type: 'uint', value: params.amount },
        { type: 'bytes32', value: recipient },
        { type: 'uint', value: params.fee ?? 0n },
        { type: 'bytes32', value: changeCommitment },
        { type: 'bytes', value: changeEncryptedMemo },
        {
            type: 'uint',
            value: uint32(params.circuitVersion, 'buildUnshieldCalldata.circuitVersion'),
        }
    );
}

/**
 * Calldata for `claimShieldedFees(bytes32,uint256,uint32,bytes,bytes,bytes,uint32)`.
 *
 * The validator identity is derived from `msg.sender` in the precompile, so it
 * is deliberately absent from the calldata.
 */
export function buildClaimShieldedFeesCalldata(params: ClaimShieldedFeesParams): string {
    EncryptedMemo.validate(params.encryptedMemo, 'buildClaimShieldedFeesCalldata.encryptedMemo');

    if (params.proof.length === 0) {
        throw new Error('claimShieldedFees: proof must not be empty');
    }
    if (params.publicSignals.length !== CLAIM_PUBLIC_SIGNALS_SIZE) {
        throw new Error(
            `claimShieldedFees: publicSignals must be ${CLAIM_PUBLIC_SIGNALS_SIZE} bytes, got ${params.publicSignals.length}`
        );
    }
    const commitment = bytes32(params.commitment, 'buildClaimShieldedFeesCalldata.commitment');

    return encodeHex(
        SP_SEL.CLAIM_SHIELDED_FEES,
        { type: 'bytes32', value: commitment },
        { type: 'uint', value: params.amount },
        { type: 'uint', value: uint32(params.assetId, 'buildClaimShieldedFeesCalldata.assetId') },
        { type: 'bytes', value: params.encryptedMemo },
        { type: 'bytes', value: params.proof },
        { type: 'bytes', value: params.publicSignals },
        {
            type: 'uint',
            value: uint32(params.circuitVersion, 'buildClaimShieldedFeesCalldata.circuitVersion'),
        }
    );
}
