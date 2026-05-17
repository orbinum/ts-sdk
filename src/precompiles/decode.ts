/**
 * Decodes calldata for known Orbinum EVM precompiles.
 *
 * Returns raw decoded values (bigint amounts, hex strings for bytes32).
 * Callers are responsible for display formatting.
 */

import { toHex } from '../utils/hex';
import { KNOWN_PRECOMPILES } from './addresses';
import { fromHex } from '../utils/hex';
import { decodeUint, decodeString } from './abi';

export type DecodedPrecompile = {
    fnSig: string;
    args: Record<string, unknown>;
};

/**
 * Decodes EVM calldata for a known Orbinum precompile.
 *
 * @param address - The precompile contract address (0x-prefixed).
 * @param input   - The transaction input data (0x-prefixed hex).
 * @returns Decoded `{ fnSig, args }` with raw values, or `null` if unknown.
 */
export function decodePrecompileCalldata(address: string, input: string): DecodedPrecompile | null {
    const info = KNOWN_PRECOMPILES[address.toLowerCase()];
    if (!info || !input || input.length < 10) return null;

    const selector = input.slice(2, 10).toLowerCase(); // strip 0x
    const fnSig = info.functions[selector];
    if (!fnSig) return null;

    // registerAlias(string)
    if (fnSig.startsWith('registerAlias')) {
        try {
            const data = fromHex(input.slice(10));
            // ABI: offset (32 bytes) + length (32 bytes) + utf-8 data
            const alias = decodeString(data, 0);
            return { fnSig, args: { alias } };
        } catch {
            return { fnSig, args: {} };
        }
    }

    // shield(uint32,bytes32,bytes)  — payable, amount = msg.value (NOT in calldata)
    // ABI head after selector:
    // [0-31] assetId | [32-63] commitment (bytes32) | [64-95] offset→memo
    if (fnSig.startsWith('shield(')) {
        try {
            const data = fromHex(input.slice(10));
            const assetId = decodeUint(data, 0);
            const commitment = toHex(data.slice(32, 64));
            // amount is msg.value — not present in calldata
            return { fnSig, args: { assetId, commitment } };
        } catch {
            return { fnSig, args: {} };
        }
    }

    // unshield(bytes,bytes32,bytes32,uint32,uint256,bytes32,uint256,bytes32)
    // ABI head after selector:
    // [0-31] offset→proof | [32-63] root | [64-95] nullifier
    // [96-127] assetId    | [128-159] amount | [160-191] recipient | [192-223] fee
    // [224-255] change_commitment
    if (fnSig.startsWith('unshield(')) {
        try {
            const data = fromHex(input.slice(10));
            const root = toHex(data.slice(32, 64));
            const nullifier = toHex(data.slice(64, 96));
            const assetId = decodeUint(data, 96);
            const amount = decodeUint(data, 128);
            const recipient = toHex(data.slice(160, 192));
            const fee = decodeUint(data, 192);
            const changeCommitment = toHex(data.slice(224, 256));
            return {
                fnSig,
                args: { root, nullifier, assetId, amount, recipient, fee, changeCommitment },
            };
        } catch {
            return { fnSig, args: {} };
        }
    }

    // privateTransfer(bytes,bytes32,bytes32[],bytes32[],bytes[],uint32,uint256)
    // ABI head after selector:
    // [0-31] offset→proof | [32-63] root | [64-95] offset→nullifiers
    // [96-127] offset→commitments | [128-159] offset→memos
    // [160-191] assetId (uint32) | [192-223] fee (uint256)
    if (fnSig.startsWith('privateTransfer(')) {
        try {
            const data = fromHex(input.slice(10));
            const root = toHex(data.slice(32, 64));
            const nullOffset = Number(decodeUint(data, 64)); // byte offset into data
            const commOffset = Number(decodeUint(data, 96)); // byte offset into data
            const nullifiers = Number(decodeUint(data, nullOffset));
            const commitments = Number(decodeUint(data, commOffset));
            const assetId = decodeUint(data, 160);
            const fee = decodeUint(data, 192);
            return { fnSig, args: { root, nullifiers, commitments, assetId, fee } };
        } catch {
            return { fnSig, args: {} };
        }
    }

    // claimShieldedFees(bytes32,uint256,uint32,bytes,bytes,bytes)
    // ABI head after selector (6 fixed slots × 32 = 192 bytes):
    // [0-31]   commitment (bytes32)
    // [32-63]  amount (uint256)
    // [64-95]  asset_id (uint32, right-aligned)
    // [96-127] offset → memo
    // [128-159] offset → proof
    // [160-191] offset → publicSignals
    if (fnSig.startsWith('claimShieldedFees(')) {
        try {
            const data = fromHex(input.slice(10));
            const commitment = toHex(data.slice(0, 32));
            const amount = decodeUint(data, 32);
            const assetId = decodeUint(data, 64);
            return { fnSig, args: { commitment, amount, assetId } };
        } catch {
            return { fnSig, args: {} };
        }
    }

    return { fnSig, args: {} };
}
